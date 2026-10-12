use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    pin::Pin,
    task::{Context, Poll},
};

#[path = "../build/mdx.rs"]
mod mdx_build;
#[path = "../build/pdx.rs"]
mod pdx_build;

use base64::{Engine, engine::general_purpose::STANDARD};
use rmcp::{
    ServiceExt,
    handler::server::ServerHandler,
    handler::server::wrapper::Parameters,
    model::{
        CallToolResult, ContentBlock, ErrorData as McpError, Implementation, ServerCapabilities,
        ServerConfig,
    },
    tool, tool_handler, tool_router,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use soundlog::{
    VgmCommand, VgmDocument,
    mdx::{
        command::MdxCommand,
        convert::{
            MdxPlaybackCheckLimits, MdxToVgmOptions, check_playback, to_vgm_stream_generator,
        },
        document::MdxDocument,
        package::MdxPackage,
        pdx::{PdxBuilder, PdxDocument},
    },
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    sync::mpsc::{UnboundedReceiver, unbounded_channel},
};

const MAX_BINARY_BYTES: usize = 32 * 1024 * 1024;
const MAX_MML_BYTES: usize = 64 * 1024;
const MAX_COMMANDS: usize = 500;
const MAX_TRACE_TICK: u64 = 100_000;
const MAX_VGM_OUTPUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_VGM_TICKS: u32 = 1_000_000;

fn failure(message: impl ToString) -> serde_json::Value {
    serde_json::json!({ "ok": false, "message": message.to_string() })
}

#[derive(Deserialize, JsonSchema)]
struct VgmParseRequest {
    /// VGM file bytes encoded as standard Base64 (maximum 32 MiB decoded).
    data_base64: String,
    /// Required zero-based command index to start returning.
    start_command: usize,
    /// Required number of commands to return (1-500).
    max_commands: usize,
}

#[derive(Deserialize, JsonSchema)]
struct MdxParseRequest {
    /// MDX file bytes encoded as standard Base64 (maximum 32 MiB decoded).
    data_base64: String,
    /// Optional zero-based track to inspect; omitted selects all tracks.
    track: Option<usize>,
    /// Required zero-based command index within each selected track to start returning.
    start_command: usize,
    /// Required number of commands returned across the selected tracks (1-500).
    max_commands: usize,
}

#[derive(Deserialize, JsonSchema)]
struct MmlParseRequest {
    /// MML source text.
    source: String,
    /// Required zero-based command index within each track to start returning.
    start_command: usize,
    /// Required number of commands to return (1-500).
    max_commands: usize,
}

#[derive(Deserialize, JsonSchema)]
struct MmlVgmTraceRequest {
    /// MML source text.
    source: String,
    /// Zero-based playback tick at the center of the returned VGM window.
    tick: u64,
    /// Required number of ticks to include before and after the requested tick (0-100).
    radius: u32,
    /// Required number of VGM commands to return (1-500).
    max_commands: usize,
    /// Optional PDX bytes encoded as standard Base64 (maximum 32 MiB decoded).
    pdx_base64: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct MmlCheckRequest {
    /// MML source text.
    source: String,
    /// Maximum playback ticks to execute (defaults to 100000).
    max_ticks: Option<u64>,
    /// Maximum MDX commands to execute (defaults to 1000000).
    max_commands: Option<u64>,
}

#[derive(Deserialize, JsonSchema)]
struct MmlCommandReferenceRequest {
    /// Optional exact MML command label to look up; omit to list all commands.
    command: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct BuildMdxRequest {
    /// Workspace identifier returned by mmlx_workspaces.
    workspace: String,
    /// Workspace-relative MML source path.
    input_path: String,
    /// Workspace-relative MDX output path. Existing files are not overwritten.
    output_path: String,
}

#[derive(Deserialize, JsonSchema)]
struct BuildPdxRequest {
    /// Workspace identifier returned by mmlx_workspaces.
    workspace: String,
    /// Workspace-relative .pdx.json manifest path.
    manifest_path: String,
    /// Workspace-relative PDX output path. Existing files are not overwritten.
    output_path: String,
}

#[derive(Deserialize, JsonSchema)]
struct BuildVgmRequest {
    /// Workspace identifier returned by mmlx_workspaces.
    workspace: String,
    /// Workspace-relative .mml or .mdx input path.
    input_path: String,
    /// Workspace-relative VGM output path. Existing files are not overwritten.
    output_path: String,
    /// Optional workspace-relative PDX file. If omitted, a referenced PDX is searched beside the input.
    pdx_path: Option<String>,
    /// ADPCM processing mode: through (default), resample, or lpf.
    adpcm_mode: Option<String>,
    /// Positive number of loop playthroughs. Omit to preserve native loop points.
    loop_count: Option<u32>,
    /// Maximum playback ticks (1-1000000; defaults to 100000).
    max_ticks: Option<u32>,
}

#[derive(Deserialize)]
struct MmlCommandCatalog {
    mdx: MmlDialectCatalog,
}

#[derive(Deserialize)]
struct MmlDialectCatalog {
    commands: BTreeMap<String, MmlCommandDescription>,
}

#[derive(Deserialize)]
struct MmlCommandDescription {
    syntax: String,
    description: String,
    #[serde(default)]
    parameters: BTreeMap<String, String>,
}

#[derive(Serialize)]
struct CommandReport {
    index: usize,
    offset: usize,
    length: usize,
    command: String,
}

#[derive(Serialize)]
struct VgmCommandReport {
    #[serde(flatten)]
    command: CommandReport,
    samples_at_issue: u64,
}

#[derive(Clone)]
struct MmlxMcpServer;

struct Stdin {
    receiver: UnboundedReceiver<io::Result<Vec<u8>>>,
    buffer: Vec<u8>,
    offset: usize,
}

impl Stdin {
    fn new() -> io::Result<Self> {
        let (sender, receiver) = unbounded_channel();
        std::thread::Builder::new()
            .name("mmlx-mcp-stdin".to_owned())
            .spawn(move || {
                let mut stdin = io::stdin().lock();
                let mut buffer = [0; 8192];
                loop {
                    match stdin.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(length) => {
                            if sender.send(Ok(buffer[..length].to_vec())).is_err() {
                                break;
                            }
                        }
                        Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                        Err(error) => {
                            let _ = sender.send(Err(error));
                            break;
                        }
                    }
                }
            })?;
        Ok(Self {
            receiver,
            buffer: Vec::new(),
            offset: 0,
        })
    }
}

impl AsyncRead for Stdin {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.offset == self.buffer.len() {
            match Pin::new(&mut self.receiver).poll_recv(context) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Some(Ok(bytes))) => {
                    self.buffer = bytes;
                    self.offset = 0;
                }
                Poll::Ready(Some(Err(error))) => return Poll::Ready(Err(error)),
                Poll::Ready(None) => return Poll::Ready(Ok(())),
            }
        }
        let length = buffer
            .remaining()
            .min(self.buffer.len().saturating_sub(self.offset));
        buffer.put_slice(&self.buffer[self.offset..self.offset + length]);
        self.offset += length;
        Poll::Ready(Ok(()))
    }
}

struct Stdout(io::Stdout);

impl AsyncWrite for Stdout {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(self.0.write(buffer))
    }

    fn poll_flush(mut self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(self.0.flush())
    }

    fn poll_shutdown(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.poll_flush(context)
    }
}

#[tool_router]
impl MmlxMcpServer {
    #[tool(
        description = "List the trusted VS Code workspace folders available for file-based MDX and PDX builds."
    )]
    fn mmlx_workspaces(&self) -> Result<CallToolResult, McpError> {
        let entries = match fs::read_dir("/workspaces") {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return json_result(&serde_json::json!({"workspaces": []}));
            }
            Err(error) => {
                return Err(McpError::internal_error(
                    format!("failed to list mounted workspaces: {error}"),
                    None,
                ));
            }
        };
        let mut workspaces = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| {
                McpError::internal_error(
                    format!("failed to read mounted workspace entry: {error}"),
                    None,
                )
            })?;
            if entry
                .file_type()
                .map_err(|error| {
                    McpError::internal_error(
                        format!("failed to inspect mounted workspace: {error}"),
                        None,
                    )
                })?
                .is_dir()
            {
                let id = entry.file_name().to_string_lossy().into_owned();
                if valid_workspace_id(&id) {
                    workspaces.push(serde_json::json!({
                        "id": id,
                        "name": id
                    }));
                }
            }
        }
        workspaces.sort_by(|left, right| left["id"].as_str().cmp(&right["id"].as_str()));
        json_result(&serde_json::json!({"workspaces": workspaces}))
    }

    #[tool(
        description = "Build a workspace-relative .mml file (up to 64 KiB) into an MDX file. Call mmlx_workspaces first; output files are created without overwriting existing files."
    )]
    fn mmlx_build_mdx(
        &self,
        params: Parameters<BuildMdxRequest>,
    ) -> Result<CallToolResult, McpError> {
        let request = params.0;
        let root = workspace_root(&request.workspace)?;
        let result = build_mdx(&root, &request.input_path, &request.output_path)?;
        json_result(&result)
    }

    #[tool(
        description = "Build a workspace-relative .pdx.json manifest (up to 1 MiB) and its relative WAV files (32 MiB combined) into a PDX file. Call mmlx_workspaces first; all files must remain inside that workspace, and output files are created without overwriting existing files."
    )]
    fn mmlx_build_pdx(
        &self,
        params: Parameters<BuildPdxRequest>,
    ) -> Result<CallToolResult, McpError> {
        let request = params.0;
        let root = workspace_root(&request.workspace)?;
        let result = build_pdx(&root, &request.manifest_path, &request.output_path)?;
        json_result(&result)
    }

    #[tool(
        description = "Build a workspace-relative .mml or .mdx file into VGM. Call mmlx_workspaces first. An optional PDX path can be supplied; otherwise a referenced PDX is searched for beside the input. Existing output files are not overwritten."
    )]
    fn mmlx_build_vgm(
        &self,
        params: Parameters<BuildVgmRequest>,
    ) -> Result<CallToolResult, McpError> {
        let request = params.0;
        let root = workspace_root(&request.workspace)?;
        let result = build_vgm(
            &root,
            &request.input_path,
            &request.output_path,
            request.pdx_path.as_deref(),
            request.adpcm_mode.as_deref(),
            request.loop_count,
            request.max_ticks,
        )?;
        json_result(&result)
    }

    #[tool(
        description = "Explain what the mmlx MCP server does, how MML, MDX/PDX, and VGM relate, and when to use each analysis tool."
    )]
    fn mmlx_help(&self) -> Result<CallToolResult, McpError> {
        json_result(&serde_json::json!({
            "server": "mmlx",
            "purpose": "Build MDX, PDX, and VGM files from workspace sources, and analyze MML source and MDX/VGM music data. The server does not render audio.",
            "formats": {
                "MML": "Human-readable music source. mmlx_build_mdx compiles a workspace .mml file into MDX, mmlx_build_vgm compiles it into VGM, mml_parse compiles it into MDX track commands with source locations, mml_check performs a bounded playback check, and mml_vgm_trace generates VGM commands around a source playback tick.",
                "MDX": "A binary music format. mmlx_build_mdx compiles MML into an MDX file, mmlx_build_vgm converts MDX into VGM, and mdx_parse inspects an existing MDX file. MDX files can reference PDX sample data.",
                "PDX": "Sample data that can be used by MDX playback. mmlx_build_pdx builds a PDX file from a workspace .pdx.json manifest and relative WAV files. mml_vgm_trace accepts optional PDX bytes; without them it uses synthetic silence for PCM samples.",
                "VGM": "A record of chip commands and timing. mmlx_build_vgm creates a VGM file from MML or MDX, vgm_parse inspects an existing VGM file, and mml_vgm_trace generates a VGM command trace from MML and maps commands to MML ticks."
            },
            "workflow": [
                "Use mmlx_workspaces to find the trusted workspace id, then mmlx_build_mdx, mmlx_build_pdx, or mmlx_build_vgm to create an output file. Build paths are workspace-relative and existing output files are never overwritten.",
                "Use mml_parse to inspect how MML compiles and where generated commands came from; request only the command window needed and advance start_command to fetch later commands.",
                "Use mml_check for a bounded playback check; it does not validate real PDX contents or audio output.",
                "Use mml_vgm_trace to inspect generated chip commands around a zero-based MML tick. Tick mapping requires a single tempo set at the start of playback.",
                "Use mdx_parse or vgm_parse to inspect existing binary files; request only the command window needed and advance start_command to fetch later commands. Binary inputs are standard Base64."
            ],
            "tools": [
                {"name": "mmlx_workspaces", "purpose": "List workspace roots available to file-based build tools."},
                {"name": "mmlx_build_mdx", "purpose": "Build a workspace MML file into MDX."},
                {"name": "mmlx_build_pdx", "purpose": "Build a PDX file from a workspace manifest and WAV samples."},
                {"name": "mmlx_build_vgm", "purpose": "Build a VGM file from workspace MML or MDX, with optional PDX samples."},
                {"name": "mmlx_help", "purpose": "Explain the server, formats, and tool selection."},
                {"name": "mml_command_reference", "purpose": "List MML commands or look up one command's syntax and description."},
                {"name": "mml_grammar", "purpose": "Return the copied Pest grammar for the supported MML dialect."},
                {"name": "mml_parse", "purpose": "Compile MML into MDX track commands with MML source locations."},
                {"name": "mml_check", "purpose": "Run a bounded MML playback check."},
                {"name": "mml_vgm_trace", "purpose": "Return generated VGM commands around an MML tick."},
                {"name": "mdx_parse", "purpose": "Inspect an existing MDX file, optionally filtered by track."},
                {"name": "vgm_parse", "purpose": "Inspect an existing VGM file."}
            ],
            "limits": {
                "mml_source_bytes": MAX_MML_BYTES,
                "binary_file_bytes": MAX_BINARY_BYTES,
                "parser_max_commands": MAX_COMMANDS,
                "pdx_manifest_bytes": 1024 * 1024,
                "pdx_wav_bytes_total": 32 * 1024 * 1024,
                "vgm_output_bytes": 64 * 1024 * 1024,
                "vgm_max_ticks": 1_000_000
            },
            "range_requirements": {
                "vgm_parse": "Requires start_command and max_commands.",
                "mdx_parse": "Requires start_command and max_commands.",
                "mml_parse": "Requires start_command and max_commands.",
                "mml_vgm_trace": "Requires tick, radius, and max_commands."
            }
        }))
    }

    #[tool(
        description = "List MML commands with syntax and descriptions, or look up one exact command label. The reference is loaded from the server's English locale catalog."
    )]
    fn mml_command_reference(
        &self,
        params: Parameters<MmlCommandReferenceRequest>,
    ) -> Result<CallToolResult, McpError> {
        let catalog: MmlCommandCatalog =
            serde_saphyr::from_str(include_str!("../../locales/en.yml")).map_err(|error| {
                McpError::internal_error(
                    format!("failed to load the MML command reference: {error}"),
                    None,
                )
            })?;
        match params.0.command {
            Some(command) => {
                let entry = catalog.mdx.commands.get(&command).ok_or_else(|| {
                    invalid_input(format!(
                        "unknown MML command {command:?}; omit command to list available commands"
                    ))
                })?;
                json_result(&serde_json::json!({
                    "source": "server/locales/en.yml",
                    "command_count": catalog.mdx.commands.len(),
                    "command": command,
                    "syntax": entry.syntax,
                    "description": entry.description,
                    "parameters": entry.parameters
                }))
            }
            None => {
                let commands = catalog
                    .mdx
                    .commands
                    .into_iter()
                    .map(|(command, entry)| {
                        serde_json::json!({
                            "command": command,
                            "syntax": entry.syntax,
                            "description": entry.description,
                            "parameters": entry.parameters
                        })
                    })
                    .collect::<Vec<_>>();
                json_result(&serde_json::json!({
                    "source": "server/locales/en.yml",
                    "command_count": commands.len(),
                    "commands": commands
                }))
            }
        }
    }

    #[tool(
        description = "Return the Pest grammar for the MXDRV MDX MML dialect as copied from crates/mmlx/src/mdx/mml.pest. This describes parser syntax; use mml_command_reference for command semantics and parameter explanations."
    )]
    fn mml_grammar(&self) -> Result<CallToolResult, McpError> {
        json_result(&serde_json::json!({
            "dialect": "MXDRV MDX MML",
            "format": "Pest grammar",
            "copied_from": "crates/mmlx/src/mdx/mml.pest",
            "note": "This is a copied grammar snapshot. It describes parser syntax, not all semantic validation or compilation constraints. Use mml_command_reference for command descriptions.",
            "grammar": include_str!("../../mml.pest")
        }))
    }

    #[tool(
        description = "Parse Base64-encoded VGM bytes and report header metadata, command offsets, lengths, and sample positions. Input is limited to 32 MiB. start_command and max_commands are required; choose the smallest useful command window and advance start_command to fetch later commands. max_commands is capped at 500."
    )]
    fn vgm_parse(&self, params: Parameters<VgmParseRequest>) -> Result<CallToolResult, McpError> {
        let request = params.0;
        let bytes = decode_binary(&request.data_base64)?;
        let max_commands = command_limit(request.max_commands)?;
        let start_command = request.start_command;
        let document = VgmDocument::try_from(bytes.as_slice())
            .map_err(|error| invalid_input(format!("failed to parse VGM: {error}")))?;
        let offsets = document.sourcemap();
        let start_command = start_command.min(document.commands.len());
        let mut samples = document
            .commands
            .iter()
            .take(start_command)
            .map(vgm_wait_samples)
            .fold(0u64, u64::saturating_add);
        let commands_total = document.commands.len().saturating_sub(start_command);
        let commands = document
            .commands
            .iter()
            .zip(offsets)
            .enumerate()
            .skip(start_command)
            .take(max_commands)
            .map(|(index, (command, (offset, length)))| {
                let samples_at_issue = samples;
                samples = samples.saturating_add(vgm_wait_samples(command));
                VgmCommandReport {
                    command: CommandReport {
                        index,
                        offset,
                        length,
                        command: format_vgm_command(command),
                    },
                    samples_at_issue,
                }
            })
            .collect::<Vec<_>>();
        let report = serde_json::json!({
            "format": "VGM",
            "file_bytes": bytes.len(),
            "version": format!("{}.{:02x}", document.header.version >> 8, document.header.version & 0xff),
            "total_samples": document.header.total_samples,
            "duration_seconds": document.header.total_samples as f64 / 44_100.0,
            "loop_samples": document.header.loop_samples,
            "loop_command_index": document.loop_command_index(),
            "ym2151_clock": document.header.ym2151_clock,
            "ym2612_clock": document.header.ym2612_clock,
            "start_command": start_command,
            "commands_total": document.commands.len(),
            "commands_in_selection": commands_total,
            "commands_returned": commands.len(),
            "truncated": commands.len() < commands_total,
            "commands": commands
        });
        json_result(&report)
    }

    #[tool(
        description = "Parse Base64-encoded MDX bytes and report title, PDX reference, per-track commands, and command byte offsets. Input is limited to 32 MiB. start_command and max_commands are required; choose the smallest useful command window and advance start_command to fetch later commands. max_commands is capped at 500; track optionally selects one track to narrow the result."
    )]
    fn mdx_parse(&self, params: Parameters<MdxParseRequest>) -> Result<CallToolResult, McpError> {
        let request = params.0;
        let bytes = decode_binary(&request.data_base64)?;
        let max_commands = command_limit(request.max_commands)?;
        let document = MdxDocument::parse(&bytes)
            .map_err(|error| invalid_input(format!("failed to parse MDX: {error}")))?;
        let source_map = document
            .sourcemap()
            .map_err(|error| invalid_input(format!("failed to map MDX commands: {error}")))?;
        let start_command = request.start_command;
        if request
            .track
            .is_some_and(|track| track >= document.tracks.len())
        {
            return Err(invalid_input(format!(
                "track must be less than {}",
                document.tracks.len()
            )));
        }
        let total_commands = document
            .tracks
            .iter()
            .enumerate()
            .filter(|(track, _)| request.track.is_none_or(|selected| selected == *track))
            .map(|(_, commands)| commands.len().saturating_sub(start_command))
            .sum::<usize>();
        let mut remaining = max_commands;
        let tracks = document.tracks.iter().enumerate()
            .filter(|(track, _)| request.track.is_none_or(|selected| selected == *track))
            .map(|(track, commands)| {
            let entries = commands.iter().zip(source_map[track].iter()).enumerate()
                .skip(start_command)
                .take(remaining)
                .map(|(index, (command, (offset, length)))| CommandReport {
                    index,
                    offset: *offset,
                    length: *length,
                    command: format!("{command:?}"),
                })
                .collect::<Vec<_>>();
            remaining = remaining.saturating_sub(entries.len());
            serde_json::json!({ "track": track, "commands_total": commands.len(), "commands": entries })
        }).collect::<Vec<_>>();
        let returned = tracks
            .iter()
            .map(|track| track["commands"].as_array().map_or(0, Vec::len))
            .sum::<usize>();
        let report = serde_json::json!({
            "format": "MDX",
            "file_bytes": bytes.len(),
            "title": document.header.title,
            "pdx_name": document.header.pdx_name,
            "track_count": document.tracks.len(),
            "commands_total": total_commands,
            "commands_returned": returned,
            "truncated": returned < total_commands,
            "track": request.track,
            "start_command": start_command,
            "tracks": tracks
        });
        json_result(&report)
    }

    #[tool(
        description = "Parse and compile MML source, returning generated MDX track commands with original MML line and column locations. start_command and max_commands are required; choose the smallest useful command window and advance start_command to fetch later commands. max_commands is capped at 500. Source is limited to 64 KiB."
    )]
    fn mml_parse(&self, params: Parameters<MmlParseRequest>) -> Result<CallToolResult, McpError> {
        let request = params.0;
        validate_mml(&request.source)?;
        let max_commands = command_limit(request.max_commands)?;
        let start_command = request.start_command;
        let parsed = mmlx::mdx::frontend::parse(&request.source)
            .map_err(|error| invalid_input(format!("failed to parse MML: {error}")))?;
        let compiled = mmlx::mdx::frontend::compile(&parsed)
            .map_err(|error| invalid_input(format!("failed to compile MML: {error}")))?;
        let document = compiled.document();
        let source_map = document.sourcemap().map_err(|error| {
            invalid_input(format!("failed to map compiled MDX commands: {error}"))
        })?;
        let mut remaining = max_commands;
        let tracks = document.tracks.iter().enumerate().map(|(track, commands)| {
            let entries = commands.iter().enumerate().skip(start_command).take(remaining).map(|(index, command)| {
                remaining -= 1;
                let source_position = compiled.source_map()
                    .get(&mmlx::mdx::frontend::MdxLocation::TrackCommand { track, index })
                    .and_then(|span| compiled.source().position(span.start()))
                    .map(|position| serde_json::json!({
                        "line": position.line_number,
                        "column": position.column
                    }));
                let (offset, length) = source_map[track][index];
                serde_json::json!({
                    "index": index,
                    "offset": offset,
                    "length": length,
                    "source": source_position,
                    "command": format!("{command:?}")
                })
            }).collect::<Vec<_>>();
            serde_json::json!({ "track": track, "commands_total": commands.len(), "commands": entries })
        }).collect::<Vec<_>>();
        let total_commands = document.tracks.iter().map(Vec::len).sum::<usize>();
        let selected_commands = document
            .tracks
            .iter()
            .map(|commands| commands.len().saturating_sub(start_command))
            .sum::<usize>();
        let returned = selected_commands.min(max_commands);
        let report = serde_json::json!({
            "format": "MML",
            "title": document.header.title,
            "pdx_name": document.header.pdx_name,
            "track_count": document.tracks.len(),
            "commands_total": total_commands,
            "commands_returned": returned,
            "truncated": returned < selected_commands,
            "start_command": start_command,
            "tracks": tracks
        });
        json_result(&report)
    }

    #[tool(
        description = "Generate VGM commands from MML and return commands around a zero-based MML playback tick. tick, radius, and max_commands are required; choose the smallest useful radius and command cap to limit output. radius is capped at 100 ticks and max_commands at 500. Supports fixed-tempo MML; variable tempo changes cannot currently be mapped exactly. Optional PDX data can be supplied as Base64."
    )]
    fn mml_vgm_trace(
        &self,
        params: Parameters<MmlVgmTraceRequest>,
    ) -> Result<CallToolResult, McpError> {
        let request = params.0;
        validate_mml(&request.source)?;
        if request.tick > MAX_TRACE_TICK {
            return Err(invalid_input(format!(
                "tick must be no greater than {MAX_TRACE_TICK}"
            )));
        }
        let radius = request.radius;
        if radius > 100 {
            return Err(invalid_input("radius must be between 0 and 100"));
        }
        let max_commands = command_limit(request.max_commands)?;
        let start_tick = request.tick.saturating_sub(u64::from(radius));
        let end_tick = request.tick.saturating_add(u64::from(radius));
        if end_tick > MAX_TRACE_TICK {
            return Err(invalid_input(format!(
                "tick plus radius must be no greater than {MAX_TRACE_TICK}"
            )));
        }
        let parsed = mmlx::mdx::frontend::parse(&request.source)
            .map_err(|error| invalid_input(format!("failed to parse MML: {error}")))?;
        let mdx = mmlx::mdx::frontend::compile(&parsed)
            .map_err(|error| invalid_input(format!("failed to compile MML: {error}")))?
            .into_document();
        let tempo_commands = mdx
            .tracks
            .iter()
            .enumerate()
            .flat_map(|(track, commands)| {
                commands
                    .iter()
                    .enumerate()
                    .filter_map(move |(index, command)| match command {
                        MdxCommand::Tempo(command) => Some((track, index, command.value.max(1))),
                        _ => None,
                    })
            })
            .collect::<Vec<_>>();
        let tempos = tempo_commands
            .iter()
            .map(|(_, _, tempo)| *tempo)
            .collect::<BTreeSet<_>>();
        let late_tempo = tempo_commands.iter().any(|(track, index, _)| {
            mdx.tracks[*track]
                .iter()
                .position(|command| matches!(command, MdxCommand::Rest(_) | MdxCommand::Note(_)))
                .is_some_and(|first_timed| *index > first_timed)
        });
        if tempos.len() > 1 || late_tempo {
            return Err(invalid_input(
                "mml_vgm_trace currently requires one tempo set at the start of playback",
            ));
        }
        let tempo = tempos.first().copied().unwrap_or(200);
        let pdx = request
            .pdx_base64
            .as_deref()
            .map(decode_binary)
            .transpose()?
            .map(|bytes| {
                PdxDocument::parse_owned(bytes)
                    .map_err(|error| invalid_input(format!("failed to parse PDX: {error}")))
            })
            .transpose()?
            .or(synthetic_pdx(&mdx).map_err(|error| {
                invalid_input(format!("failed to prepare synthetic PDX: {error}"))
            })?);
        let package = MdxPackage { mdx, pdx };
        let end_tick_limit = u32::try_from(end_tick.saturating_add(2))
            .map_err(|_| invalid_input("tick range exceeds playback limit"))?;
        let options = MdxToVgmOptions {
            loop_count: Some(1),
            max_ticks: Some(end_tick_limit),
            max_commands_per_tick: Some(10_000),
            ..Default::default()
        };
        let mut generator = to_vgm_stream_generator(package, options)
            .map_err(|error| invalid_input(format!("failed to create VGM stream: {error}")))?;
        let tick_microseconds = 256 * u64::from(256 - u16::from(tempo));
        let mut sample_remainder = 0u64;
        let mut tick_samples_remaining =
            next_tick_samples(tick_microseconds, &mut sample_remainder);
        let mut samples = 0u64;
        let mut samples_in_tick = 0u64;
        let mut tick = 0u64;
        let mut command_index = 0usize;
        let mut commands = Vec::new();
        let mut ended = false;
        let mut truncated = false;
        while let Some(command) = generator
            .next_command()
            .map_err(|error| invalid_input(format!("failed to generate VGM command: {error}")))?
        {
            let wait_samples = vgm_wait_samples(&command);
            if tick >= start_tick && tick <= end_tick {
                if commands.len() < max_commands {
                    commands.push(serde_json::json!({
                        "index": command_index,
                        "tick": tick,
                        "sample": samples,
                        "command": format_vgm_command(&command)
                    }));
                } else {
                    truncated = true;
                }
            }
            command_index = command_index.saturating_add(1);
            samples = samples.saturating_add(wait_samples);
            samples_in_tick = samples_in_tick.saturating_add(wait_samples);
            if wait_samples > 0 && samples_in_tick >= tick_samples_remaining {
                tick = tick.saturating_add(1);
                samples_in_tick = samples_in_tick.saturating_sub(tick_samples_remaining);
                tick_samples_remaining =
                    next_tick_samples(tick_microseconds, &mut sample_remainder);
                if tick > end_tick {
                    break;
                }
            }
            if command_index > 20_000_000 {
                return Err(invalid_input(
                    "VGM trace exceeded the 20000000-command processing limit",
                ));
            }
        }
        if tick <= end_tick {
            ended = true;
        }
        json_result(&serde_json::json!({
            "format": "MML to VGM trace",
            "tick_indexing": "zero-based",
            "requested_tick": request.tick,
            "start_tick": start_tick,
            "end_tick": end_tick,
            "tempo": tempo,
            "samples_per_second": 44_100,
            "commands_returned": commands.len(),
            "truncated": truncated,
            "stream_ended_before_window_end": ended,
            "commands": commands,
            "note": "Tick mapping is exact for fixed-tempo playback. Without pdx_base64, PCM data uses synthetic silence."
        }))
    }

    #[tool(
        description = "Parse, compile, and run a bounded finite playback check on MML. Synthetic silent PCM samples are used when needed; this does not validate a real PDX file or audio output."
    )]
    fn mml_check(&self, params: Parameters<MmlCheckRequest>) -> Result<CallToolResult, McpError> {
        let request = params.0;
        validate_mml(&request.source)?;
        let max_ticks = request.max_ticks.unwrap_or(100_000);
        let max_commands = request.max_commands.unwrap_or(1_000_000);
        if max_ticks == 0 || max_ticks > 1_000_000 || max_commands == 0 || max_commands > 10_000_000
        {
            return Err(invalid_input(
                "max_ticks must be 1-1000000 and max_commands must be 1-10000000",
            ));
        }
        let parsed = mmlx::mdx::frontend::parse(&request.source)
            .map_err(|error| invalid_input(format!("failed to parse MML: {error}")))?;
        let mdx = mmlx::mdx::frontend::compile(&parsed)
            .map_err(|error| invalid_input(format!("failed to compile MML: {error}")))?
            .into_document();
        let pdx = synthetic_pdx(&mdx)
            .map_err(|error| invalid_input(format!("failed to prepare synthetic PDX: {error}")))?;
        let package = MdxPackage { mdx, pdx };
        check_playback(
            &package,
            MdxToVgmOptions {
                loop_count: Some(1),
                ..Default::default()
            },
            MdxPlaybackCheckLimits {
                max_ticks,
                max_commands,
            },
        )
        .map_err(|error| invalid_input(format!("MML playback check failed: {error}")))?;
        json_result(&serde_json::json!({
            "valid": true,
            "playback_check": "passed",
            "ticks_limit": max_ticks,
            "commands_limit": max_commands,
            "note": "Synthetic silent PCM samples are used; real PDX contents and audio are not validated."
        }))
    }
}

#[tool_handler]
impl ServerHandler for MmlxMcpServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_server_info(
            Implementation::new("mmlx-mcp-server", env!("CARGO_PKG_VERSION")),
        )
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let service = MmlxMcpServer
        .serve((Stdin::new()?, Stdout(io::stdout())))
        .await?;
    service.waiting().await?;
    Ok(())
}

fn invalid_input(message: impl Into<std::borrow::Cow<'static, str>>) -> McpError {
    McpError::invalid_params(message, None)
}

fn json_result(value: &impl Serialize) -> Result<CallToolResult, McpError> {
    let output = serde_json::to_string_pretty(value).map_err(|error| {
        McpError::internal_error(format!("failed to serialize tool result: {error}"), None)
    })?;
    Ok(CallToolResult::success(vec![ContentBlock::text(output)]))
}

fn decode_binary(encoded: &str) -> Result<Vec<u8>, McpError> {
    if encoded.len() > MAX_BINARY_BYTES.div_ceil(3) * 4 {
        return Err(invalid_input(
            "Base64 input exceeds the 32 MiB binary size limit",
        ));
    }
    let bytes = STANDARD.decode(encoded).map_err(|error| {
        invalid_input(format!(
            "data_base64 must be valid standard Base64: {error}"
        ))
    })?;
    if bytes.len() > MAX_BINARY_BYTES {
        return Err(invalid_input(
            "Base64 input exceeds the 32 MiB binary size limit",
        ));
    }
    Ok(bytes)
}

fn valid_workspace_id(workspace: &str) -> bool {
    !workspace.is_empty()
        && workspace
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn workspace_root(workspace: &str) -> Result<PathBuf, McpError> {
    if !valid_workspace_id(workspace) {
        return Err(invalid_input(
            "workspace must be an id returned by mmlx_workspaces",
        ));
    }
    let root = Path::new("/workspaces").join(workspace);
    let metadata = fs::metadata(&root).map_err(|error| {
        invalid_input(format!("workspace {workspace:?} is unavailable: {error}"))
    })?;
    if !metadata.is_dir() {
        return Err(invalid_input(format!(
            "workspace {workspace:?} is not a directory"
        )));
    }
    Ok(root)
}

fn workspace_relative_path(relative: &str) -> Result<PathBuf, McpError> {
    let path = Path::new(relative);
    if relative.is_empty()
        || relative.contains('\\')
        || relative.ends_with('/')
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(invalid_input(
            "file paths must be non-empty workspace-relative paths without traversal",
        ));
    }
    Ok(path.to_path_buf())
}

fn workspace_input(root: &Path, relative: &str) -> Result<PathBuf, McpError> {
    let relative = workspace_relative_path(relative)?;
    let path = root.join(&relative);
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(invalid_input(
                "input files must remain inside the selected workspace",
            ));
        };
        current.push(name);
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| invalid_input(format!("could not read {relative:?}: {error}")))?;
        if metadata.file_type().is_symlink() {
            return Err(invalid_input(
                "input files must not traverse symbolic links",
            ));
        }
    }
    if !path.is_file() {
        return Err(invalid_input(format!("{relative:?} is not a file")));
    }
    Ok(path)
}

fn workspace_output(root: &Path, relative: &str) -> Result<PathBuf, McpError> {
    let relative = workspace_relative_path(relative)?;
    let mut components = relative.components().peekable();
    let mut parent = root.to_path_buf();
    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            return Err(invalid_input(
                "output paths must remain inside the selected workspace",
            ));
        };
        if components.peek().is_none() {
            return Ok(parent.join(name));
        }
        parent.push(name);
        match fs::symlink_metadata(&parent) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(invalid_input(
                    "output directories must not traverse symbolic links or non-directories",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&parent).map_err(|error| {
                    McpError::internal_error(
                        format!("could not create output directory: {error}"),
                        None,
                    )
                })?;
            }
            Err(error) => {
                return Err(McpError::internal_error(
                    format!("could not inspect output directory: {error}"),
                    None,
                ));
            }
        }
    }
    Err(invalid_input("output path must include a file name"))
}

fn write_build_output(path: &Path, bytes: &[u8]) -> Result<(), McpError> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            McpError::internal_error(
                format!("could not create build output {}: {error}", path.display()),
                None,
            )
        })?;
    if let Err(error) = file.write_all(bytes).and_then(|()| file.flush()) {
        drop(file);
        return match fs::remove_file(path) {
            Ok(()) => Err(McpError::internal_error(
                format!("could not write build output {}: {error}", path.display()),
                None,
            )),
            Err(cleanup_error) => Err(McpError::internal_error(
                format!(
                    "could not write build output {}: {error}; could not remove the partial file: {cleanup_error}",
                    path.display()
                ),
                None,
            )),
        };
    }
    Ok(())
}

fn build_mdx(
    root: &Path,
    input_path: &str,
    output_path: &str,
) -> Result<serde_json::Value, McpError> {
    let input = workspace_input(root, input_path)?;
    if !input_path.to_ascii_lowercase().ends_with(".mml") {
        return Err(invalid_input("MDX build input must be an .mml file"));
    }
    if !output_path.to_ascii_lowercase().ends_with(".mdx") {
        return Err(invalid_input("MDX build output must end with .mdx"));
    }
    let size = fs::metadata(&input)
        .map_err(|error| McpError::internal_error(error.to_string(), None))?
        .len();
    if size > MAX_MML_BYTES as u64 {
        return Err(invalid_input(format!(
            "MML input exceeds the {MAX_MML_BYTES}-byte limit"
        )));
    }
    let source = fs::read_to_string(&input)
        .map_err(|error| invalid_input(format!("could not read MML source: {error}")))?;
    let bytes = mdx_build::build(&serde_json::json!({"source": source})).map_err(|error| {
        invalid_input(
            error["message"]
                .as_str()
                .unwrap_or("MML compilation failed")
                .to_owned(),
        )
    })?;
    let output = workspace_output(root, output_path)?;
    write_build_output(&output, &bytes)?;
    Ok(serde_json::json!({
        "format": "MDX",
        "input_path": input_path,
        "output_path": output_path,
        "byte_length": bytes.len()
    }))
}

fn build_pdx(
    root: &Path,
    manifest_path: &str,
    output_path: &str,
) -> Result<serde_json::Value, McpError> {
    let manifest = workspace_input(root, manifest_path)?;
    if !manifest_path.to_ascii_lowercase().ends_with(".pdx.json") {
        return Err(invalid_input(
            "PDX build input must be a .pdx.json manifest",
        ));
    }
    if !output_path.to_ascii_lowercase().ends_with(".pdx") {
        return Err(invalid_input("PDX build output must end with .pdx"));
    }
    let bytes = pdx_build::build_pdx_within(&manifest, &root)
        .map_err(|error| invalid_input(format!("PDX build failed: {error}")))?;
    let output = workspace_output(&root, output_path)?;
    write_build_output(&output, &bytes)?;
    Ok(serde_json::json!({
        "format": "PDX",
        "manifest_path": manifest_path,
        "output_path": output_path,
        "byte_length": bytes.len()
    }))
}

fn find_referenced_pdx(
    root: &Path,
    input_path: &str,
    name: &str,
) -> Result<Option<(String, PathBuf)>, McpError> {
    let name = name.replace('\\', "/");
    let Some(name) = Path::new(&name).file_name() else {
        return Ok(None);
    };
    let name = name.to_string_lossy().into_owned();
    let input_directory = Path::new(input_path)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let Some(filename) = Path::new(&name).file_name() else {
        return Ok(None);
    };
    let filename = filename.to_string_lossy().into_owned();
    let candidates = if filename.to_ascii_lowercase().ends_with(".pdx") {
        vec![filename.clone()]
    } else {
        vec![format!("{filename}.pdx"), filename.clone()]
    };
    let directory = root.join(input_directory);
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(McpError::internal_error(
                format!("could not search for referenced PDX: {error}"),
                None,
            ));
        }
    };
    let mut filenames = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            McpError::internal_error(
                format!("could not inspect PDX directory entry: {error}"),
                None,
            )
        })?;
        if entry
            .file_type()
            .map_err(|error| {
                McpError::internal_error(format!("could not inspect PDX candidate: {error}"), None)
            })?
            .is_file()
        {
            filenames.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    for candidate in candidates {
        if let Some(found) = filenames
            .iter()
            .find(|entry| entry.eq_ignore_ascii_case(&candidate))
        {
            let relative = input_directory
                .join(found)
                .to_string_lossy()
                .replace('\\', "/");
            let path = workspace_input(root, &relative)?;
            return Ok(Some((relative, path)));
        }
    }
    Ok(None)
}

fn build_vgm(
    root: &Path,
    input_path: &str,
    output_path: &str,
    pdx_path: Option<&str>,
    adpcm_mode: Option<&str>,
    loop_count: Option<u32>,
    max_ticks: Option<u32>,
) -> Result<serde_json::Value, McpError> {
    let input = workspace_input(root, input_path)?;
    let input_kind = if input_path.to_ascii_lowercase().ends_with(".mml") {
        "mml"
    } else if input_path.to_ascii_lowercase().ends_with(".mdx") {
        "mdx"
    } else {
        return Err(invalid_input(
            "VGM build input must be an .mml or .mdx file",
        ));
    };
    if !output_path.to_ascii_lowercase().ends_with(".vgm") {
        return Err(invalid_input("VGM build output must end with .vgm"));
    }
    let max_ticks = max_ticks.unwrap_or(100_000);
    if !(1..=MAX_VGM_TICKS).contains(&max_ticks) {
        return Err(invalid_input(format!(
            "max_ticks must be between 1 and {MAX_VGM_TICKS}"
        )));
    }
    if loop_count == Some(0) {
        return Err(invalid_input(
            "loop_count must be positive; omit it to preserve native loop points",
        ));
    }
    let adpcm_mode = adpcm_mode.unwrap_or("through");
    if !matches!(adpcm_mode, "through" | "resample" | "lpf") {
        return Err(invalid_input(
            "adpcm_mode must be through, resample, or lpf",
        ));
    }

    let input_bytes = fs::metadata(&input)
        .map_err(|error| McpError::internal_error(error.to_string(), None))?
        .len();
    let (source, bytes) = if input_kind == "mml" {
        if input_bytes > MAX_MML_BYTES as u64 {
            return Err(invalid_input(format!(
                "MML input exceeds the {MAX_MML_BYTES}-byte limit"
            )));
        }
        (
            Some(
                fs::read_to_string(&input).map_err(|error| {
                    invalid_input(format!("could not read MML source: {error}"))
                })?,
            ),
            None,
        )
    } else {
        if input_bytes > MAX_BINARY_BYTES as u64 {
            return Err(invalid_input(format!(
                "MDX input exceeds the {MAX_BINARY_BYTES}-byte limit"
            )));
        }
        (
            None,
            Some(
                fs::read(&input)
                    .map_err(|error| invalid_input(format!("could not read MDX file: {error}")))?,
            ),
        )
    };

    let pdx = if let Some(pdx_path) = pdx_path {
        if !pdx_path.to_ascii_lowercase().ends_with(".pdx") {
            return Err(invalid_input("PDX input must end with .pdx"));
        }
        let path = workspace_input(root, pdx_path)?;
        Some((pdx_path.to_owned(), path))
    } else {
        None
    };
    let pdx_bytes = if let Some((_, path)) = &pdx {
        let size = fs::metadata(path)
            .map_err(|error| McpError::internal_error(error.to_string(), None))?
            .len();
        if size > MAX_BINARY_BYTES as u64 {
            return Err(invalid_input(format!(
                "PDX input exceeds the {MAX_BINARY_BYTES}-byte limit"
            )));
        }
        Some(
            fs::read(path)
                .map_err(|error| invalid_input(format!("could not read PDX file: {error}")))?,
        )
    } else {
        None
    };

    let mut request = serde_json::json!({
        "inputKind": input_kind,
        "format": "vgm",
        "adpcmMode": adpcm_mode,
        "loopCount": loop_count,
        "maxTicks": max_ticks,
        "source": source,
        "bytes": bytes,
        "pdx": pdx_bytes,
    });
    let result = mdx_build::build(&request);
    let (result, pdx_used) = match (result, pdx) {
        (Err(error), None) if error["pdxName"].is_string() => {
            let pdx_name = error["pdxName"].as_str().unwrap();
            let Some((relative_path, path)) = find_referenced_pdx(root, input_path, pdx_name)?
            else {
                return Err(invalid_input(format!(
                    "{}; provide pdx_path to the required sample file",
                    error["message"].as_str().unwrap_or("PDX file required")
                )));
            };
            let size = fs::metadata(&path)
                .map_err(|error| McpError::internal_error(error.to_string(), None))?
                .len();
            if size > MAX_BINARY_BYTES as u64 {
                return Err(invalid_input(format!(
                    "PDX input exceeds the {MAX_BINARY_BYTES}-byte limit"
                )));
            }
            let pdx_bytes = fs::read(path)
                .map_err(|error| invalid_input(format!("could not read PDX file: {error}")))?;
            request["pdx"] = serde_json::to_value(pdx_bytes).map_err(|error| {
                McpError::internal_error(format!("could not encode PDX input: {error}"), None)
            })?;
            (mdx_build::build(&request), Some(relative_path))
        }
        (result, explicit_pdx) => (result, explicit_pdx.map(|(path, _)| path)),
    };
    let bytes = result.map_err(|error| {
        invalid_input(
            error["message"]
                .as_str()
                .unwrap_or("VGM conversion failed")
                .to_owned(),
        )
    })?;
    if bytes.len() > MAX_VGM_OUTPUT_BYTES {
        return Err(invalid_input(format!(
            "generated VGM exceeds the {MAX_VGM_OUTPUT_BYTES}-byte output limit"
        )));
    }
    let output = workspace_output(root, output_path)?;
    write_build_output(&output, &bytes)?;
    Ok(serde_json::json!({
        "format": "VGM",
        "input_path": input_path,
        "output_path": output_path,
        "pdx_path": pdx_used,
        "adpcm_mode": adpcm_mode,
        "loop_count": loop_count,
        "max_ticks": max_ticks,
        "byte_length": bytes.len()
    }))
}

fn next_tick_samples(tick_microseconds: u64, sample_remainder: &mut u64) -> u64 {
    let sample_accumulator = *sample_remainder + tick_microseconds * 44_100;
    *sample_remainder = sample_accumulator % 1_000_000;
    sample_accumulator / 1_000_000
}

fn validate_mml(source: &str) -> Result<(), McpError> {
    if source.is_empty() || source.len() > MAX_MML_BYTES {
        return Err(invalid_input("source must contain 1-65536 UTF-8 bytes"));
    }
    Ok(())
}

fn command_limit(limit: usize) -> Result<usize, McpError> {
    if !(1..=MAX_COMMANDS).contains(&limit) {
        return Err(invalid_input("max_commands must be between 1 and 500"));
    }
    Ok(limit)
}

fn vgm_wait_samples(command: &VgmCommand) -> u64 {
    match command {
        VgmCommand::WaitSamples(wait) => u64::from(wait.0),
        VgmCommand::Wait735Samples(_) => 735,
        VgmCommand::Wait882Samples(_) => 882,
        VgmCommand::WaitNSample(wait) => u64::from(wait.0) + 1,
        VgmCommand::YM2612Port0Address2AWriteAndWaitN(wait) => u64::from(wait.0),
        _ => 0,
    }
}

fn format_vgm_command(command: &VgmCommand) -> String {
    match command {
        VgmCommand::DataBlock(block) => format!(
            "DataBlock(type=0x{:02X}, size={})",
            block.data_type, block.size
        ),
        VgmCommand::PcmRamWrite(write) => format!(
            "PcmRamWrite(chip_type={:?}, read_offset=0x{:X}, write_offset=0x{:X}, size={})",
            write.chip_type, write.read_offset, write.write_offset, write.size
        ),
        _ => format!("{command:?}"),
    }
}

fn synthetic_pdx(mdx: &MdxDocument) -> Result<Option<PdxDocument>, soundlog::ParseError> {
    let mut banks = BTreeSet::from([0]);
    let mut notes = BTreeSet::new();
    for command in mdx.tracks.iter().skip(8).flatten() {
        match command {
            MdxCommand::VoiceOrPcmBank(command) => {
                banks.insert(usize::from(command.value));
            }
            MdxCommand::Note(command) => {
                if let Some(note) = command.note.checked_sub(0x80) {
                    notes.insert(usize::from(note));
                }
            }
            _ => {}
        }
    }
    if notes.is_empty() && mdx.header.pdx_name.is_none() {
        return Ok(None);
    }
    let mut builder = PdxBuilder::new();
    for bank in banks {
        for &note in &notes {
            builder.set_sample(bank, note, vec![0; 4])?;
        }
    }
    Ok(Some(builder.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use soundlog::vgm::command::PcmRamWrite;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn result_text(result: CallToolResult) -> serde_json::Value {
        let result = serde_json::to_value(result).unwrap();
        serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap()
    }

    fn test_workspace() -> PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "mmlx-mcp-build-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn write_wav(path: &Path) {
        let mut writer = hound::WavWriter::create(
            path,
            hound::WavSpec {
                channels: 1,
                sample_rate: 15_625,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for sample in [-32768_i16, 0, 32767] {
            writer.write_sample(sample).unwrap();
        }
        writer.finalize().unwrap();
    }

    #[test]
    fn help_explains_formats_and_analysis_tools() {
        let report = result_text(MmlxMcpServer.mmlx_help().unwrap());
        assert!(
            report["formats"]["MML"]
                .as_str()
                .unwrap()
                .contains("mml_parse")
        );
        assert!(report["formats"]["MDX"].as_str().unwrap().contains("PDX"));
        assert!(
            report["formats"]["VGM"]
                .as_str()
                .unwrap()
                .contains("mml_vgm_trace")
        );
        assert_eq!(report["limits"]["parser_max_commands"], MAX_COMMANDS);
        assert!(
            report["range_requirements"]["mml_vgm_trace"]
                .as_str()
                .unwrap()
                .contains("radius")
        );
        assert!(
            report["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["name"] == "mmlx_build_vgm")
        );
    }

    #[test]
    fn workspace_mdx_build_writes_valid_output_without_overwriting() {
        let root = test_workspace();
        fs::write(root.join("song.mml"), "A r4").unwrap();

        let report = build_mdx(&root, "song.mml", "generated/song.mdx").unwrap();
        let bytes = fs::read(root.join("generated/song.mdx")).unwrap();
        assert_eq!(report["format"], "MDX");
        assert_eq!(report["byte_length"], bytes.len());
        assert!(MdxDocument::parse(&bytes).is_ok());
        assert!(build_mdx(&root, "song.mml", "generated/song.mdx").is_err());
        assert!(build_mdx(&root, "../song.mml", "escape.mdx").is_err());
        assert!(build_mdx(&root, "song.mml", "../escape.mdx").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn workspace_pdx_build_reads_relative_wav_and_writes_output() {
        let root = test_workspace();
        fs::create_dir(root.join("samples")).unwrap();
        write_wav(&root.join("samples/tone.wav"));
        fs::write(
            root.join("bank.pdx.json"),
            r#"{"version":1,"samples":[{"bank":0,"voiceNo":0,"wav":"samples/tone.wav"}]}"#,
        )
        .unwrap();

        let report = build_pdx(&root, "bank.pdx.json", "generated/bank.pdx").unwrap();
        let bytes = fs::read(root.join("generated/bank.pdx")).unwrap();
        assert_eq!(report["format"], "PDX");
        assert_eq!(report["byte_length"], bytes.len());
        assert!(PdxDocument::parse(&bytes).is_ok());
        assert!(build_pdx(&root, "bank.pdx.json", "generated/bank.pdx").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn workspace_vgm_builds_mml_and_mdx_and_discovers_referenced_pdx() {
        let root = test_workspace();
        fs::write(root.join("song.mml"), "A r4").unwrap();
        let result = build_vgm(
            &root,
            "song.mml",
            "generated/song.vgm",
            None,
            None,
            None,
            None,
        )
        .unwrap();
        let vgm = fs::read(root.join("generated/song.vgm")).unwrap();
        assert_eq!(result["format"], "VGM");
        assert_eq!(result["pdx_path"], serde_json::Value::Null);
        assert!(VgmDocument::try_from(vgm.as_slice()).is_ok());

        let mdx = mdx_build::build(&serde_json::json!({"source": "A r4"})).unwrap();
        fs::write(root.join("song.mdx"), mdx).unwrap();
        let result = build_vgm(
            &root,
            "song.mdx",
            "generated/song-from-mdx.vgm",
            None,
            Some("resample"),
            Some(2),
            Some(1000),
        )
        .unwrap();
        assert_eq!(result["loop_count"], 2);
        assert_eq!(result["max_ticks"], 1000);
        assert!(
            VgmDocument::try_from(
                fs::read(root.join("generated/song-from-mdx.vgm"))
                    .unwrap()
                    .as_slice()
            )
            .is_ok()
        );

        fs::write(root.join("pcm.mml"), "#pcmfile \"drums\"\nA r4").unwrap();
        let pdx = PdxBuilder::new().finalize().to_bytes();
        fs::write(root.join("DRUMS.PDX"), pdx).unwrap();
        let result = build_vgm(
            &root,
            "pcm.mml",
            "generated/pcm.vgm",
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(result["pdx_path"], "DRUMS.PDX");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn command_reference_lists_and_looks_up_localized_commands() {
        let list = result_text(
            MmlxMcpServer
                .mml_command_reference(Parameters(MmlCommandReferenceRequest { command: None }))
                .unwrap(),
        );
        assert_eq!(list["source"], "server/locales/en.yml");
        assert_eq!(
            list["command_count"].as_u64().unwrap() as usize,
            list["commands"].as_array().unwrap().len()
        );
        assert!(
            list["commands"]
                .as_array()
                .unwrap()
                .iter()
                .any(|command| command["command"] == "@t")
        );

        let detail = result_text(
            MmlxMcpServer
                .mml_command_reference(Parameters(MmlCommandReferenceRequest {
                    command: Some("t".to_owned()),
                }))
                .unwrap(),
        );
        assert_eq!(detail["syntax"], "t<19..4882 BPM>");
        assert_eq!(detail["parameters"]["p0"], "BPM");
    }

    #[test]
    fn command_reference_rejects_unknown_commands() {
        assert!(
            MmlxMcpServer
                .mml_command_reference(Parameters(MmlCommandReferenceRequest {
                    command: Some("not-a-command".to_owned()),
                }))
                .is_err()
        );
    }

    #[test]
    fn grammar_tool_returns_the_copied_pest_grammar() {
        let report = result_text(MmlxMcpServer.mml_grammar().unwrap());
        assert_eq!(report["copied_from"], "crates/mmlx/src/mdx/mml.pest");
        let grammar = report["grammar"].as_str().unwrap();
        assert!(grammar.contains("document = { SOI ~ line* ~ EOI }"));
        assert!(grammar.contains("numeric_note = { \"n\" ~ number ~ (\",\" ~ duration)? }"));
    }

    #[test]
    fn vgm_tool_reports_offsets_and_sample_positions() {
        let bytes: Vec<u8> = soundlog::VgmBuilder::new().finalize().into();
        let result = MmlxMcpServer
            .vgm_parse(Parameters(VgmParseRequest {
                data_base64: STANDARD.encode(bytes),
                start_command: 0,
                max_commands: 10,
            }))
            .unwrap();
        let report = result_text(result);
        assert_eq!(report["format"], "VGM");
        assert!(report["commands_total"].as_u64().unwrap() > 0);
        assert!(report["commands"][0]["offset"].as_u64().unwrap() > 0);
        assert_eq!(report["commands"][0]["samples_at_issue"], 0);
    }

    #[test]
    fn mdx_tool_reports_track_commands_and_source_offsets() {
        let parsed = mmlx::mdx::frontend::parse("A r4").unwrap();
        let mdx = mmlx::mdx::frontend::compile(&parsed)
            .unwrap()
            .into_document();
        let bytes = mdx.to_bytes().unwrap();
        let result = MmlxMcpServer
            .mdx_parse(Parameters(MdxParseRequest {
                data_base64: STANDARD.encode(bytes),
                track: Some(0),
                start_command: 0,
                max_commands: 10,
            }))
            .unwrap();
        let report = result_text(result);
        assert_eq!(report["format"], "MDX");
        assert!(
            report["tracks"][0]["commands"][0]["command"]
                .as_str()
                .unwrap()
                .starts_with("Rest(")
        );
        assert!(
            report["tracks"][0]["commands"][0]["offset"]
                .as_u64()
                .is_some()
        );
    }

    #[test]
    fn binary_and_command_limits_are_enforced() {
        assert!(decode_binary(&"A".repeat(MAX_BINARY_BYTES.div_ceil(3) * 4 + 4)).is_err());
        assert!(command_limit(0).is_err());
        assert_eq!(command_limit(MAX_COMMANDS).unwrap(), MAX_COMMANDS);
        assert!(command_limit(MAX_COMMANDS + 1).is_err());
    }

    #[test]
    fn fixed_tempo_sample_accumulator_matches_fractional_tick_lengths() {
        let mut remainder = 0;
        let samples = (0..10)
            .map(|_| next_tick_samples(256 * (256 - 200), &mut remainder))
            .sum::<u64>();
        assert_eq!(samples, 6_322);
    }

    #[test]
    fn mml_trace_returns_vgm_commands_in_requested_tick_window() {
        let result = MmlxMcpServer
            .mml_vgm_trace(Parameters(MmlVgmTraceRequest {
                source: "A t120 o4 c4".to_owned(),
                tick: 2,
                radius: 1,
                max_commands: 100,
                pdx_base64: None,
            }))
            .unwrap();
        let report = result_text(result);
        assert_eq!(report["start_tick"], 1);
        assert_eq!(report["end_tick"], 3);
        let commands = report["commands"].as_array().unwrap();
        assert!(!commands.is_empty());
        assert!(commands.iter().all(|command| {
            let tick = command["tick"].as_u64().unwrap();
            (1..=3).contains(&tick)
        }));
    }

    #[test]
    fn vgm_dump_commands_omit_embedded_payload_bytes() {
        let command = VgmCommand::PcmRamWrite(Box::new(PcmRamWrite {
            marker: 0x66,
            chip_type: soundlog::vgm::command::StreamChipType::Ym2612Pcm,
            read_offset: 0,
            write_offset: 0,
            size: 32 * 1024,
            data: vec![0x7f; 32 * 1024],
        }));
        let formatted = format_vgm_command(&command);
        assert!(formatted.contains("size=32768"));
        assert!(formatted.len() < 200);
    }
}
