use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    pin::Pin,
    task::{Context, Poll},
};

use base64::{Engine, engine::general_purpose::STANDARD};
use mmlx_lsp_server::build::{mdx as mdx_build, pdx as pdx_build};
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
    VgmCallbackStream, VgmCommand, VgmDocument, VgmHeader, VgmStream,
    chip::event::StateEvent,
    mdx::{
        command::MdxCommand,
        convert::{
            AdpcmMode, MdxPlaybackCheckLimits, MdxToVgmOptions, check_playback,
            to_vgm_stream_generator,
        },
        document::MdxDocument,
        package::MdxPackage,
        pdx::{PdxBuilder, PdxDocument},
    },
    vgm::detail::{DataBlockType, parse_data_block},
    vgm::{command::Instance, stream::StreamResult},
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
const MAX_STREAM_LOOP_COUNT: u32 = 1_000;

#[derive(Deserialize, JsonSchema)]
struct VgmParseRequest {
    /// Workspace identifier returned by mmlx_workspaces.
    workspace: String,
    /// Workspace-relative VGM input path (maximum 32 MiB).
    input_path: String,
    /// Workspace-relative text output path. Existing files are not overwritten.
    output_path: String,
}

#[derive(Deserialize, JsonSchema)]
struct MdxParseRequest {
    /// Workspace identifier returned by mmlx_workspaces.
    workspace: String,
    /// Workspace-relative MDX input path (maximum 32 MiB).
    input_path: String,
    /// Workspace-relative text output path. Existing files are not overwritten.
    output_path: String,
}

#[derive(Deserialize, JsonSchema)]
struct VgmStreamRequest {
    /// Workspace identifier returned by mmlx_workspaces.
    workspace: String,
    /// Workspace-relative VGM input path (maximum 32 MiB).
    input_path: String,
    /// Workspace-relative text output path. Existing files are not overwritten.
    output_path: String,
    /// Number of loop playthroughs; defaults to one.
    loop_count: Option<u32>,
    /// Optional VGM loop modifier override.
    loop_modifier: Option<u8>,
    /// Optional VGM loop base override.
    loop_base: Option<i8>,
}

#[derive(Deserialize, JsonSchema)]
struct MdxStreamRequest {
    /// Workspace identifier returned by mmlx_workspaces.
    workspace: String,
    /// Workspace-relative .mml or .mdx input path.
    input_path: String,
    /// Workspace-relative text output path. Existing files are not overwritten.
    output_path: String,
    /// Optional workspace-relative PDX file.
    pdx_path: Option<String>,
    /// YM2151 clock in Hz (defaults to 4 MHz).
    ym2151_clock: Option<u32>,
    /// OKIM6258 clock in Hz.
    okim6258_clock: Option<u32>,
    /// Number of whole-song playthroughs; defaults to one.
    loop_count: Option<u32>,
    /// ADPCM mode: through (default), resample, or lpf.
    adpcm_mode: Option<String>,
    /// Maximum playback ticks (defaults to 100000; maximum 1000000).
    max_ticks: Option<u32>,
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
        description = "List the trusted VS Code workspace folders available for file-based build and parse-output tools."
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
                "MDX": "A binary music format. mmlx_build_mdx compiles MML into an MDX file, mmlx_build_vgm converts MDX into VGM, mdx_parse writes all commands from a workspace-relative MDX file to a workspace text file, and mdx_stream lazily converts MML or MDX into a soundlog-style register/event stream. MDX files can reference PDX sample data.",
                "PDX": "Sample data that can be used by MDX playback. mmlx_build_pdx builds a PDX file from a workspace .pdx.json manifest and relative WAV files. mml_vgm_trace accepts optional PDX bytes; without them it uses synthetic silence for PCM samples.",
                "VGM": "A record of chip commands and timing. mmlx_build_vgm creates a VGM file from MML or MDX, vgm_parse writes the complete command table from a workspace-relative VGM file to a workspace text file, vgm_stream writes soundlog-style register writes and detected events, and mml_vgm_trace generates a VGM command trace from MML and maps commands to MML ticks."
            },
            "workflow": [
                "Use mmlx_workspaces to find the trusted workspace id, then pass it with workspace-relative input_path and output_path values to mdx_parse or vgm_parse. Build tools also use workspace-relative paths; output files are created without overwriting existing files.",
                "Use vgm_stream for an existing VGM file or mdx_stream for lazy MML/MDX playback; both save the complete soundlog-style stream to output_path.",
                "Use mml_parse to inspect how MML compiles and where generated commands came from; request a command window and advance start_command to fetch later commands.",
                "Use mml_check for a bounded playback check; it does not validate real PDX contents or audio output.",
                "Use mml_vgm_trace to inspect generated chip commands around a zero-based MML tick. Tick mapping requires a single tempo set at the start of playback.",
                "Use mdx_parse or vgm_parse to save the complete text command table from a workspace-relative binary input_path to a workspace-relative output_path."
            ],
            "tools": [
                {"name": "mmlx_workspaces", "purpose": "List workspace roots available to file-based build, parse, and stream-output tools."},
                {"name": "mmlx_build_mdx", "purpose": "Build a workspace MML file into MDX."},
                {"name": "mmlx_build_pdx", "purpose": "Build a PDX file from a workspace manifest and WAV samples."},
                {"name": "mmlx_build_vgm", "purpose": "Build a VGM file from workspace MML or MDX, with optional PDX samples."},
                {"name": "mmlx_help", "purpose": "Explain the server, formats, and tool selection."},
                {"name": "mml_command_reference", "purpose": "List MML commands or look up one command's syntax and description."},
                {"name": "mml_grammar", "purpose": "Return the copied Pest grammar for the supported MML dialect."},
                {"name": "mml_parse", "purpose": "Compile MML into MDX track commands with MML source locations."},
                {"name": "mml_check", "purpose": "Run a bounded MML playback check."},
                {"name": "mml_vgm_trace", "purpose": "Return generated VGM commands around an MML tick."},
                {"name": "mdx_parse", "purpose": "Write every track command from a workspace MDX file to a workspace text file."},
                {"name": "vgm_parse", "purpose": "Write every command from a workspace VGM file to a workspace text file."},
                {"name": "mdx_stream", "purpose": "Write soundlog-style register writes and detected events from lazy MML/MDX playback."},
                {"name": "vgm_stream", "purpose": "Write soundlog-style register writes and detected events from a VGM file."}
            ],
            "limits": {
                "mml_source_bytes": MAX_MML_BYTES,
                "binary_file_bytes": MAX_BINARY_BYTES,
                "command_window_max_commands": MAX_COMMANDS,
                "pdx_manifest_bytes": 1024 * 1024,
                "pdx_wav_bytes_total": 32 * 1024 * 1024,
                "vgm_output_bytes": 64 * 1024 * 1024,
                "vgm_max_ticks": MAX_VGM_TICKS,
                "stream_loop_count_max": MAX_STREAM_LOOP_COUNT
            },
            "range_requirements": {
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
            "grammar": include_str!("../../assets/grammar/mml.pest")
        }))
    }

    #[tool(
        description = "Parse a workspace-relative VGM file (up to 32 MiB) and write the complete command table in soundlog parse format to a new workspace-relative output_path. Call mmlx_workspaces first; existing output files are not overwritten."
    )]
    fn vgm_parse(&self, params: Parameters<VgmParseRequest>) -> Result<CallToolResult, McpError> {
        let request = params.0;
        let root = workspace_root(&request.workspace)?;
        let bytes = read_binary_input(&root, &request.input_path)?;
        let document = VgmDocument::try_from(bytes.as_slice())
            .map_err(|error| invalid_input(format!("failed to parse VGM file: {error}")))?;
        let (command_count, byte_length) =
            write_parse_output(&root, &request.output_path, "VGM parse output", |file| {
                write_vgm_parse(&document, file)
            })?;
        let report = serde_json::json!({
            "format": "VGM",
            "workspace": request.workspace,
            "input_path": request.input_path,
            "output_path": request.output_path,
            "command_count": command_count,
            "byte_length": byte_length
        });
        json_result(&report)
    }

    #[tool(
        description = "Parse a workspace-relative MDX file (up to 32 MiB) and write every track command in soundlog mdx parse format to a new workspace-relative output_path. Call mmlx_workspaces first; existing output files are not overwritten."
    )]
    fn mdx_parse(&self, params: Parameters<MdxParseRequest>) -> Result<CallToolResult, McpError> {
        let request = params.0;
        let root = workspace_root(&request.workspace)?;
        let bytes = read_binary_input(&root, &request.input_path)?;
        let document = MdxDocument::parse(&bytes)
            .map_err(|error| invalid_input(format!("failed to parse MDX file: {error}")))?;
        let source_map = document
            .sourcemap()
            .map_err(|error| invalid_input(format!("failed to map MDX commands: {error}")))?;
        let track_count = document.tracks.len();
        let (command_count, byte_length) =
            write_parse_output(&root, &request.output_path, "MDX parse output", |file| {
                write_mdx_parse(&document, &source_map, file)
            })?;
        let report = serde_json::json!({
            "format": "MDX",
            "workspace": request.workspace,
            "input_path": request.input_path,
            "output_path": request.output_path,
            "track_count": track_count,
            "command_count": command_count,
            "byte_length": byte_length
        });
        json_result(&report)
    }

    #[tool(
        description = "Stream a workspace-relative VGM file through soundlog's register/event tracker and write every stream row to a new workspace-relative output_path. Call mmlx_workspaces first. Input is limited to 32 MiB; loop_count defaults to one and is capped at 1000."
    )]
    fn vgm_stream(&self, params: Parameters<VgmStreamRequest>) -> Result<CallToolResult, McpError> {
        let request = params.0;
        let root = workspace_root(&request.workspace)?;
        let bytes = read_binary_input(&root, &request.input_path)?;
        let header = VgmHeader::from_bytes(&bytes)
            .map_err(|error| invalid_input(format!("failed to parse VGM header: {error}")))?;
        let loop_count = request.loop_count.unwrap_or(1).max(1);
        if loop_count > MAX_STREAM_LOOP_COUNT {
            return Err(invalid_input(format!(
                "loop_count must be no greater than {MAX_STREAM_LOOP_COUNT}"
            )));
        }
        let mut stream = VgmStream::from_vgm(bytes)
            .map_err(|error| invalid_input(format!("failed to create VGM stream: {error}")))?;
        stream.set_loop_count(Some(loop_count));
        if let Some(modifier) = request.loop_modifier {
            stream.set_loop_modifier(modifier);
        }
        if let Some(base) = request.loop_base {
            stream.set_loop_base(base);
        }
        let instances = header.chip_instances();
        let (command_count, byte_length) = write_stream_output(
            &root,
            &request.output_path,
            "VGM stream output",
            stream,
            |callback_stream| callback_stream.track_chips(&instances),
        )?;
        json_result(&serde_json::json!({
            "format": "VGM stream",
            "workspace": request.workspace,
            "input_path": request.input_path,
            "output_path": request.output_path,
            "command_count": command_count,
            "byte_length": byte_length,
            "loop_count": loop_count
        }))
    }

    #[tool(
        description = "Convert a workspace-relative .mml or .mdx file lazily to a VGM command stream and save soundlog-style register writes and detected events to a new workspace-relative output_path. Call mmlx_workspaces first. Input files are limited to 32 MiB, MML to 64 KiB, loop_count to 1000, and max_ticks to 1000000."
    )]
    fn mdx_stream(&self, params: Parameters<MdxStreamRequest>) -> Result<CallToolResult, McpError> {
        let request = params.0;
        let root = workspace_root(&request.workspace)?;
        let (package, pdx_path) =
            load_mdx_stream_package(&root, &request.input_path, request.pdx_path.as_deref())?;
        let loop_count = request.loop_count.unwrap_or(1).max(1);
        if loop_count > MAX_STREAM_LOOP_COUNT {
            return Err(invalid_input(format!(
                "loop_count must be no greater than {MAX_STREAM_LOOP_COUNT}"
            )));
        }
        let adpcm_mode = match request.adpcm_mode.as_deref().unwrap_or("through") {
            "through" => AdpcmMode::Through,
            "resample" => AdpcmMode::Resample,
            "lpf" => AdpcmMode::Lpf,
            _ => {
                return Err(invalid_input(
                    "adpcm_mode must be through, resample, or lpf",
                ));
            }
        };
        let max_ticks = request.max_ticks.unwrap_or(100_000);
        if !(1..=MAX_VGM_TICKS).contains(&max_ticks) {
            return Err(invalid_input(format!(
                "max_ticks must be between 1 and {MAX_VGM_TICKS}"
            )));
        }
        let options = MdxToVgmOptions {
            ym2151_clock: request.ym2151_clock.unwrap_or(4_000_000),
            okim6258_clock: request
                .okim6258_clock
                .unwrap_or(soundlog::mdx::pcm_mixer::PCM8_RECOMMENDED_OKIM6258_CLOCK_HZ),
            loop_count: Some(loop_count),
            adpcm_mode,
            max_ticks: Some(max_ticks),
            ..Default::default()
        };
        let has_pcm = package.drives_okim6258();
        let generator = to_vgm_stream_generator(package, options)
            .map_err(|error| invalid_input(format!("MDX to VGM conversion failed: {error}")))?;
        let stream = VgmStream::from_generator(generator);
        let (command_count, byte_length) = write_stream_output(
            &root,
            &request.output_path,
            "MDX stream output",
            stream,
            |callback_stream| {
                use soundlog::chip::state::{Okim6258State, Ym2151State};

                callback_stream
                    .track_state::<Ym2151State>(Instance::Primary, options.ym2151_clock as f32);
                if has_pcm {
                    callback_stream.track_state::<Okim6258State>(
                        Instance::Primary,
                        options.okim6258_clock as f32,
                    );
                }
            },
        )?;
        json_result(&serde_json::json!({
            "format": "MDX stream",
            "workspace": request.workspace,
            "input_path": request.input_path,
            "pdx_path": pdx_path,
            "output_path": request.output_path,
            "command_count": command_count,
            "byte_length": byte_length,
            "loop_count": loop_count,
            "max_ticks": max_ticks
        }))
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

fn read_binary_input(root: &Path, relative: &str) -> Result<Vec<u8>, McpError> {
    let path = workspace_input(root, relative)?;
    let size = fs::metadata(&path)
        .map_err(|error| {
            McpError::internal_error(format!("could not inspect input file: {error}"), None)
        })?
        .len();
    if size > MAX_BINARY_BYTES as u64 {
        return Err(invalid_input(format!(
            "input file exceeds the {} MiB binary size limit",
            MAX_BINARY_BYTES / (1024 * 1024)
        )));
    }
    let bytes = fs::read(&path).map_err(|error| {
        McpError::internal_error(
            format!("could not read input file {}: {error}", path.display()),
            None,
        )
    })?;
    if bytes.len() > MAX_BINARY_BYTES {
        return Err(invalid_input(format!(
            "input file exceeds the {} MiB binary size limit",
            MAX_BINARY_BYTES / (1024 * 1024)
        )));
    }
    Ok(bytes)
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

fn write_output_file<T>(
    path: &Path,
    output_kind: &str,
    write_output: impl FnOnce(&mut fs::File) -> Result<T, McpError>,
) -> Result<(T, u64), McpError> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            McpError::internal_error(
                format!("could not create {output_kind} {}: {error}", path.display()),
                None,
            )
        })?;
    let result = write_output(&mut file).and_then(|value| {
        file.flush().map_err(|error| {
            McpError::internal_error(
                format!("could not flush {output_kind} {}: {error}", path.display()),
                None,
            )
        })?;
        let length = file.metadata().map_err(|error| {
            McpError::internal_error(
                format!(
                    "could not inspect {output_kind} {}: {error}",
                    path.display()
                ),
                None,
            )
        })?;
        Ok((value, length.len()))
    });
    match result {
        Ok(result) => Ok(result),
        Err(error) => {
            drop(file);
            match fs::remove_file(path) {
                Ok(()) => Err(McpError::internal_error(
                    format!("could not write {output_kind} {}: {error}", path.display()),
                    None,
                )),
                Err(cleanup_error) => Err(McpError::internal_error(
                    format!(
                        "could not write {output_kind} {}: {error}; could not remove the partial file: {cleanup_error}",
                        path.display()
                    ),
                    None,
                )),
            }
        }
    }
}

fn write_build_output(path: &Path, bytes: &[u8]) -> Result<(), McpError> {
    write_output_file(path, "build output", |file| {
        file.write_all(bytes)
            .map_err(|error| McpError::internal_error(error.to_string(), None))
    })
    .map(|_| ())
}

fn write_parse_output<T>(
    root: &Path,
    relative: &str,
    output_kind: &str,
    write_output: impl FnOnce(&mut fs::File) -> io::Result<T>,
) -> Result<(T, u64), McpError> {
    let path = workspace_output(root, relative)?;
    write_output_file(&path, output_kind, |file| {
        write_output(file).map_err(|error| McpError::internal_error(error.to_string(), None))
    })
}

fn write_stream_output(
    root: &Path,
    relative: &str,
    output_kind: &str,
    stream: VgmStream,
    track_state: impl FnOnce(&mut VgmCallbackStream<'_>),
) -> Result<(usize, u64), McpError> {
    let path = workspace_output(root, relative)?;
    write_output_file(&path, output_kind, |file| {
        write_callback_stream(stream, file, track_state)
    })
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
    let bytes = pdx_build::build_pdx_within(&manifest, root)
        .map_err(|error| invalid_input(format!("PDX build failed: {error}")))?;
    let output = workspace_output(root, output_path)?;
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

fn load_mdx_stream_package(
    root: &Path,
    input_path: &str,
    pdx_path: Option<&str>,
) -> Result<(MdxPackage, Option<String>), McpError> {
    let input = workspace_input(root, input_path)?;
    let mdx_bytes = if input_path.to_ascii_lowercase().ends_with(".mml") {
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
        validate_mml(&source)?;
        let parsed = mmlx::mdx::frontend::parse(&source)
            .map_err(|error| invalid_input(format!("failed to parse MML: {error}")))?;
        let document = mmlx::mdx::frontend::compile(&parsed)
            .map_err(|error| invalid_input(format!("failed to compile MML: {error}")))?
            .into_document();
        document
            .to_bytes()
            .map_err(|error| invalid_input(format!("failed to serialize compiled MDX: {error}")))?
    } else if input_path.to_ascii_lowercase().ends_with(".mdx") {
        read_binary_input(root, input_path)?
    } else {
        return Err(invalid_input(
            "MDX stream input must be an .mml or .mdx file",
        ));
    };
    let document = MdxDocument::parse(&mdx_bytes)
        .map_err(|error| invalid_input(format!("failed to parse MDX file: {error}")))?;
    let pdx_path = if let Some(pdx_path) = pdx_path {
        if !pdx_path.to_ascii_lowercase().ends_with(".pdx") {
            return Err(invalid_input("PDX input must end with .pdx"));
        }
        workspace_input(root, pdx_path)?;
        Some(pdx_path.to_owned())
    } else if let Some(name) = document.header.pdx_name.as_deref() {
        find_referenced_pdx(root, input_path, name)?.map(|(relative_path, _)| relative_path)
    } else {
        None
    };
    let pdx_bytes = pdx_path
        .as_deref()
        .map(|path| read_binary_input(root, path))
        .transpose()?;
    let package = MdxPackage::parse_owned(mdx_bytes, pdx_bytes)
        .map_err(|error| invalid_input(format!("failed to parse MDX package: {error}")))?;
    Ok((package, pdx_path))
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

fn write_vgm_parse(document: &VgmDocument, output: &mut impl io::Write) -> io::Result<usize> {
    let offsets_and_lengths = document.command_offsets_and_lengths();
    writeln!(
        output,
        "{:<12} {:<8} {:<8} {:<8} Command",
        "Samples", "Index", "Offset", "Length"
    )?;
    let mut total_samples = 0u64;
    for (index, (command, (offset, length))) in document
        .commands
        .iter()
        .zip(offsets_and_lengths.iter())
        .enumerate()
    {
        let samples_at_issue = total_samples;
        total_samples += vgm_wait_samples(command);
        writeln!(
            output,
            "{:<12} {:<8} 0x{:06X} {:<8} {:<80}",
            samples_at_issue,
            index,
            offset,
            length,
            VgmCommandBrief(command)
        )?;
    }
    Ok(document.commands.len())
}

fn write_mdx_parse(
    document: &MdxDocument,
    source_map: &[Vec<(usize, usize)>],
    output: &mut impl io::Write,
) -> io::Result<usize> {
    writeln!(
        output,
        "{:<8} {:<8} {:<8} {:<8} Command",
        "Track", "Index", "Offset", "Length"
    )?;
    let mut command_count = 0;
    for (track, commands) in document.tracks.iter().enumerate() {
        for (index, command) in commands.iter().enumerate() {
            let (offset, length) = source_map
                .get(track)
                .and_then(|track_map| track_map.get(index))
                .copied()
                .unwrap_or((0, 0));
            writeln!(
                output,
                "{:<8} {:<8} 0x{:06x} {:<8} {:?}",
                track, index, offset, length, command
            )?;
            command_count += 1;
        }
    }
    Ok(command_count)
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

struct VgmCommandBrief<'a>(&'a VgmCommand);

impl std::fmt::Display for VgmCommandBrief<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        use VgmCommand::*;

        match self.0 {
            AY8910StereoMask(mask) => write!(f, "AY8910StereoMask({:?})", mask),
            WaitSamples(wait) => write!(f, "WaitSamples({})", wait.0),
            Wait735Samples(_) => write!(f, "Wait735Samples"),
            Wait882Samples(_) => write!(f, "Wait882Samples"),
            WaitNSample(wait) => write!(f, "WaitNSample(n={}, wait={})", wait.0, wait.0 + 1),
            EndOfData(_) => write!(f, "EndOfData"),
            DataBlock(block) => match parse_data_block(*block.clone()) {
                Ok(data_type) => write!(
                    f,
                    "DataBlock({}, size={})",
                    DataBlockTypeBrief(&data_type),
                    block.size
                ),
                Err((_, error)) => {
                    write!(f, "DataBlock(parse_error={}, size={})", error, block.size)
                }
            },
            PcmRamWrite(write) => write!(f, "PcmRamWrite({:?})", write),
            YM2612Port0Address2AWriteAndWaitN(wait) => {
                write!(f, "YM2612Port0Address2AWriteAndWaitN({:?})", wait)
            }
            SetupStreamControl(stream) => write!(
                f,
                "SetupStreamControl(id={}, chip={:?})",
                stream.stream_id, stream.chip_type
            ),
            SetStreamData(stream) => write!(
                f,
                "SetStreamData(id={}, bank=0x{:02X})",
                stream.stream_id, stream.data_bank_id
            ),
            SetStreamFrequency(stream) => write!(
                f,
                "SetStreamFrequency(id={}, freq={})",
                stream.stream_id, stream.frequency
            ),
            StartStream(stream) => write!(
                f,
                "StartStream(id={}, offset=0x{:X})",
                stream.stream_id, stream.data_start_offset
            ),
            StopStream(stream) => write!(f, "StopStream(id={})", stream.stream_id),
            StartStreamFastCall(stream) => write!(f, "StartStreamFastCall({:?})", stream),
            SeekOffset(seek) => write!(f, "SeekOffset({:?})", seek),
            Sn76489Write(instance, spec) => {
                write!(f, "Sn76489Write({:?}, 0x{:02X})", instance, spec.value)
            }
            Ym2413Write(instance, spec) => write!(
                f,
                "Ym2413Write({:?}, 0x{:02X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            Ym2612Write(instance, spec) => write!(
                f,
                "Ym2612Write({:?}, 0x{:02X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            Ym2151Write(instance, spec) => write!(
                f,
                "Ym2151Write({:?}, 0x{:02X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            SegaPcmWrite(instance, spec) => write!(
                f,
                "SegaPcmWrite({:?}, 0x{:04X}=0x{:02X})",
                instance, spec.offset, spec.value
            ),
            Rf5c68U8Write(instance, spec) => write!(
                f,
                "Rf5c68U8Write({:?}, 0x{:02X}=0x{:02X})",
                instance, spec.offset, spec.value
            ),
            Rf5c68U16Write(instance, spec) => write!(
                f,
                "Rf5c68U16Write({:?}, 0x{:04X}=0x{:02X})",
                instance, spec.offset, spec.value
            ),
            Ym2203Write(instance, spec) => write!(
                f,
                "Ym2203Write({:?}, 0x{:02X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            Ym2608Write(instance, spec) => write!(
                f,
                "Ym2608Write({:?}, P0x{:02X}:0x{:02X}=0x{:02X})",
                instance, spec.port, spec.register, spec.value
            ),
            Ym2610bWrite(instance, spec) => write!(
                f,
                "Ym2610bWrite({:?}, P0x{:02X}:0x{:02X}=0x{:02X})",
                instance, spec.port, spec.register, spec.value
            ),
            Ym3812Write(instance, spec) => write!(
                f,
                "Ym3812Write({:?}, 0x{:02X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            Ym3526Write(instance, spec) => write!(
                f,
                "Ym3526Write({:?}, 0x{:02X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            Y8950Write(instance, spec) => write!(
                f,
                "Y8950Write({:?}, 0x{:02X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            Ymf262Write(instance, spec) => write!(f, "Ymf262Write({:?}, {:?})", instance, spec),
            Ymf278bWrite(instance, spec) => {
                write!(f, "Ymf278bWrite({:?}, {:?})", instance, spec)
            }
            Ymf271Write(instance, spec) => write!(f, "Ymf271Write({:?}, {:?})", instance, spec),
            Scc1Write(instance, spec) => write!(
                f,
                "Scc1Write({:?}, P0x{:02X}:0x{:02X}=0x{:02X})",
                instance, spec.port, spec.register, spec.value
            ),
            Ymz280bWrite(instance, spec) => write!(
                f,
                "Ymz280bWrite({:?}, 0x{:02X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            Rf5c164U8Write(instance, spec) => write!(
                f,
                "Rf5c164U8Write({:?}, 0x{:02X}=0x{:02X})",
                instance, spec.offset, spec.value
            ),
            Rf5c164U16Write(instance, spec) => write!(
                f,
                "Rf5c164U16Write({:?}, 0x{:04X}=0x{:02X})",
                instance, spec.offset, spec.value
            ),
            PwmWrite(instance, spec) => write!(
                f,
                "PwmWrite({:?}, reg=0x{:02X}=0x{:06X})",
                instance,
                spec.register,
                spec.value & 0x00FF_FFFF
            ),
            Ay8910Write(instance, spec) => write!(
                f,
                "Ay8910Write({:?}, 0x{:02X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            GbDmgWrite(instance, spec) => write!(
                f,
                "GbDmgWrite({:?}, 0x{:02X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            NesApuWrite(instance, spec) => write!(
                f,
                "NesApuWrite({:?}, 0x{:02X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            MultiPcmWrite(instance, spec) => write!(
                f,
                "MultiPcmWrite({:?}, 0x{:02X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            MultiPcmBankWrite(instance, spec) => {
                write!(f, "MultiPcmBankWrite({:?}, {:?})", instance, spec)
            }
            Upd7759Write(instance, spec) => write!(
                f,
                "Upd7759Write({:?}, 0x{:02X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            Okim6258Write(instance, spec) => write!(
                f,
                "Okim6258Write({:?}, 0x{:02X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            Okim6295Write(instance, spec) => write!(
                f,
                "Okim6295Write({:?}, 0x{:02X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            K054539Write(instance, spec) => write!(
                f,
                "K054539Write({:?}, 0x{:04X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            Huc6280Write(instance, spec) => write!(
                f,
                "Huc6280Write({:?}, 0x{:02X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            C140Write(instance, spec) => write!(
                f,
                "C140Write({:?}, 0x{:04X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            K053260Write(instance, spec) => write!(
                f,
                "K053260Write({:?}, 0x{:02X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            PokeyWrite(instance, spec) => write!(
                f,
                "PokeyWrite({:?}, 0x{:02X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            QsoundWrite(instance, spec) => write!(
                f,
                "QsoundWrite({:?}, 0x{:04X}=0x{:04X})",
                instance, spec.register, spec.value
            ),
            ScspWrite(instance, spec) => write!(
                f,
                "ScspWrite({:?}, 0x{:04X}=0x{:02X})",
                instance, spec.offset, spec.value
            ),
            WonderSwanWrite(instance, spec) => write!(
                f,
                "WonderSwanWrite({:?}, 0x{:04X}=0x{:02X})",
                instance, spec.offset, spec.value
            ),
            WonderSwanRegWrite(instance, spec) => write!(
                f,
                "WonderSwanRegWrite({:?}, 0x{:02X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            VsuWrite(instance, spec) => write!(
                f,
                "VsuWrite({:?}, 0x{:04X}=0x{:02X})",
                instance, spec.offset, spec.value
            ),
            Saa1099Write(instance, spec) => write!(
                f,
                "Saa1099Write({:?}, 0x{:02X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            Es5503Write(instance, spec) => write!(
                f,
                "Es5503Write({:?}, 0x{:04X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            Es5506BEWrite(instance, spec) => write!(
                f,
                "Es5506BEWrite({:?}, 0x{:02X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            Es5506D6Write(instance, spec) => write!(
                f,
                "Es5506D6Write({:?}, 0x{:02X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            X1010Write(instance, spec) => write!(
                f,
                "X1010Write({:?}, 0x{:04X}=0x{:02X})",
                instance, spec.offset, spec.value
            ),
            C352Write(instance, spec) => write!(
                f,
                "C352Write({:?}, 0x{:04X}=0x{:04X})",
                instance, spec.register, spec.value
            ),
            Ga20Write(instance, spec) => write!(
                f,
                "Ga20Write({:?}, 0x{:02X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            MikeyWrite(instance, spec) => write!(
                f,
                "MikeyWrite({:?}, 0x{:02X}=0x{:02X})",
                instance, spec.register, spec.value
            ),
            GameGearPsgWrite(instance, spec) => {
                write!(f, "GameGearPsgWrite({:?}, 0x{:02X})", instance, spec.value)
            }
            ReservedU8Write(reserved) => write!(f, "ReservedU8Write({:?})", reserved),
            ReservedU16Write(reserved) => write!(f, "ReservedU16Write({:?})", reserved),
            ReservedU24Write(reserved) => write!(f, "ReservedU24Write({:?})", reserved),
            ReservedU32Write(reserved) => write!(f, "ReservedU32Write({:?})", reserved),
            UnknownCommand(unknown) => write!(f, "UnknownCommand({:?})", unknown),
        }
    }
}

fn format_stream_command(command: &VgmCommand) -> String {
    match command {
        VgmCommand::PcmRamWrite(write) => format!("PcmRamWrite({write:?})"),
        _ => format!("{}", VgmCommandBrief(command)),
    }
}

struct DataBlockTypeBrief<'a>(&'a DataBlockType);

impl std::fmt::Display for DataBlockTypeBrief<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.0 {
            DataBlockType::UncompressedStream(stream) => {
                write!(f, "UncompressedStream({:?})", stream.chip_type)
            }
            DataBlockType::CompressedStream(stream) => write!(
                f,
                "CompressedStream({:?}, {:?})",
                stream.chip_type, stream.compression_type
            ),
            DataBlockType::DecompressionTable(table) => {
                write!(f, "DecompressionTable({:?})", table.compression_type)
            }
            DataBlockType::RomRamDump(dump) => {
                write!(f, "RomRamDump({:?})", dump.chip_type)
            }
            DataBlockType::RamWrite16(write) => {
                write!(f, "RamWrite16({:?})", write.chip_type)
            }
            DataBlockType::RamWrite32(write) => {
                write!(f, "RamWrite32({:?})", write.chip_type)
            }
        }
    }
}

fn format_stream_event(event: &StateEvent) -> String {
    match event {
        StateEvent::KeyOn { channel, tone } => {
            if let Some(freq) = tone.freq_hz {
                format!(
                    "KeyOn(ch={channel}, fnum=0x{:03X}({}), freq={freq:.2}Hz)",
                    tone.fnum, tone.fnum
                )
            } else {
                format!(
                    "KeyOn(ch={channel}, fnum={}, block={})",
                    tone.fnum, tone.block
                )
            }
        }
        StateEvent::KeyOff { channel } => format!("KeyOff(ch={channel})"),
        StateEvent::ToneChange { channel, tone } => {
            if let Some(freq) = tone.freq_hz {
                format!(
                    "ToneChange(ch={channel}, fnum=0x{:03X}({}), freq={freq:.2}Hz)",
                    tone.fnum, tone.fnum
                )
            } else {
                format!(
                    "ToneChange(ch={channel}, fnum={}, block={})",
                    tone.fnum, tone.block
                )
            }
        }
    }
}

fn write_stream_line(
    output: &mut impl io::Write,
    samples: u64,
    command: &str,
    events: &[StateEvent],
) -> io::Result<()> {
    write!(output, "{samples:<12} {command} ")?;
    for (index, event) in events.iter().enumerate() {
        if index > 0 {
            write!(output, ", ")?;
        }
        write!(output, "{}", format_stream_event(event))?;
    }
    writeln!(output)
}

fn write_callback_stream(
    stream: VgmStream,
    output: &mut impl io::Write,
    track_state: impl FnOnce(&mut VgmCallbackStream<'_>),
) -> Result<usize, McpError> {
    use std::{
        cell::{Cell, RefCell},
        rc::Rc,
    };

    let mut callback_stream = VgmCallbackStream::new(stream);
    track_state(&mut callback_stream);
    writeln!(output, "{:<12} {:<40} Events", "Samples", "Register Write")
        .map_err(|error| McpError::internal_error(error.to_string(), None))?;

    let writer = Rc::new(RefCell::new(output));
    let pending_line = Rc::new(RefCell::new(None::<(u64, String)>));
    let events = Rc::new(RefCell::new(Vec::<StateEvent>::new()));
    let write_error = Rc::new(RefCell::new(None::<io::Error>));
    let total_samples = Cell::new(0u64);
    let command_count = Cell::new(0usize);

    {
        let writer = Rc::clone(&writer);
        let pending_line = Rc::clone(&pending_line);
        let events = Rc::clone(&events);
        let write_error = Rc::clone(&write_error);
        let total_samples = &total_samples;
        let command_count = &command_count;
        callback_stream.on_any_command(move |command, _sample| {
            if let Some((sample, register_write)) = pending_line.borrow_mut().take() {
                let pending_events = std::mem::take(&mut *events.borrow_mut());
                if let Err(error) = write_stream_line(
                    &mut **writer.borrow_mut(),
                    sample,
                    &register_write,
                    &pending_events,
                ) {
                    *write_error.borrow_mut() = Some(error);
                }
            }
            if write_error.borrow().is_none() {
                let sample = total_samples.get();
                *pending_line.borrow_mut() = Some((sample, format_stream_command(command)));
                total_samples.set(sample.saturating_add(vgm_wait_samples(command)));
                command_count.set(command_count.get().saturating_add(1));
            }
        });
    }

    macro_rules! collect_events {
        ($($spec_type:ty),+ $(,)?) => {
            $(
                {
                    let event_sink = Rc::clone(&events);
                    callback_stream.on_write(move |_, _: $spec_type, _, event| {
                        if let Some(event) = event {
                            event_sink.borrow_mut().extend(event);
                        }
                    });
                }
            )+
        };
    }

    collect_events!(
        soundlog::chip::Ym2612Spec,
        soundlog::chip::Ym2151Spec,
        soundlog::chip::Ym2203Spec,
        soundlog::chip::Ym2608Spec,
        soundlog::chip::Ym2610Spec,
        soundlog::chip::Ym2413Spec,
        soundlog::chip::Ym3812Spec,
        soundlog::chip::Ym3526Spec,
        soundlog::chip::Y8950Spec,
        soundlog::chip::PsgSpec,
        soundlog::chip::Ay8910Spec,
        soundlog::chip::Huc6280Spec,
        soundlog::chip::PokeySpec,
        soundlog::chip::Saa1099Spec,
        soundlog::chip::WonderSwanSpec,
        soundlog::chip::VsuSpec,
        soundlog::chip::MikeySpec,
        soundlog::chip::Ymf262Spec,
        soundlog::chip::Ymf271Spec,
        soundlog::chip::Ymf278bSpec,
        soundlog::chip::GbDmgSpec,
        soundlog::chip::NesApuSpec,
        soundlog::chip::SegaPcmSpec,
        soundlog::chip::Rf5c68U8Spec,
        soundlog::chip::QsoundSpec,
        soundlog::chip::ScspSpec,
        soundlog::chip::Es5503Spec,
        soundlog::chip::Es5506U8Spec,
        soundlog::chip::X1010Spec,
        soundlog::chip::C352Spec,
        soundlog::chip::Ga20Spec,
        soundlog::chip::Ymz280bSpec,
        soundlog::chip::MultiPcmSpec,
        soundlog::chip::Upd7759Spec,
        soundlog::chip::Okim6258Spec,
        soundlog::chip::Okim6295Spec,
        soundlog::chip::K054539Spec,
        soundlog::chip::C140Spec,
        soundlog::chip::K053260Spec,
        soundlog::chip::Scc1Spec,
        soundlog::chip::Rf5c164U8Spec,
        soundlog::chip::PwmSpec
    );

    for result in callback_stream {
        match result {
            Ok(StreamResult::Command(_)) => {}
            Ok(StreamResult::EndOfStream) => break,
            Ok(StreamResult::NeedsMoreData) => {
                return Err(invalid_input(
                    "stream ended while waiting for more input data",
                ));
            }
            Err(error) => {
                return Err(invalid_input(format!("stream processing failed: {error}")));
            }
        }
        if let Some(error) = write_error.borrow_mut().take() {
            return Err(McpError::internal_error(
                format!("could not write stream output: {error}"),
                None,
            ));
        }
    }

    if let Some((sample, register_write)) = pending_line.borrow_mut().take() {
        let pending_events = std::mem::take(&mut *events.borrow_mut());
        write_stream_line(
            &mut **writer.borrow_mut(),
            sample,
            &register_write,
            &pending_events,
        )
        .map_err(|error| McpError::internal_error(error.to_string(), None))?;
    }
    Ok(command_count.get())
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
    use soundlog::vgm::command::{PcmRamWrite, WaitSamples};
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
        assert_eq!(
            report["limits"]["command_window_max_commands"],
            MAX_COMMANDS
        );
        assert_eq!(
            report["limits"]["stream_loop_count_max"],
            MAX_STREAM_LOOP_COUNT
        );
        assert!(
            report["range_requirements"]["mml_vgm_trace"]
                .as_str()
                .unwrap()
                .contains("radius")
        );
        assert!(report["range_requirements"].get("vgm_parse").is_none());
        assert!(report["range_requirements"].get("mdx_parse").is_none());
        assert!(
            report["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["name"] == "mmlx_build_vgm")
        );
        assert!(
            report["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["name"] == "vgm_stream")
        );
        assert!(
            report["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["name"] == "mdx_stream")
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
    fn vgm_tool_writes_all_commands_in_soundlog_parse_format_without_overwriting() {
        let mut builder = soundlog::VgmBuilder::new();
        for _ in 0..=MAX_COMMANDS {
            builder.add_vgm_command(WaitSamples(1));
        }
        let bytes: Vec<u8> = builder.finalize().into();
        let root = test_workspace();
        fs::write(root.join("input.vgm"), &bytes).unwrap();
        let input = read_binary_input(&root, "input.vgm").unwrap();
        let document = VgmDocument::try_from(input.as_slice()).unwrap();
        let (command_count, byte_length) = write_parse_output(
            &root,
            "reports/full-vgm-parse.txt",
            "VGM parse output",
            |file| write_vgm_parse(&document, file),
        )
        .unwrap();
        let output = fs::read_to_string(root.join("reports/full-vgm-parse.txt")).unwrap();
        let lines = output.lines().collect::<Vec<_>>();
        assert_eq!(
            lines[0],
            format!(
                "{:<12} {:<8} {:<8} {:<8} Command",
                "Samples", "Index", "Offset", "Length"
            )
        );
        assert_eq!(lines.len(), document.commands.len() + 1);
        assert_eq!(command_count, document.commands.len());
        assert_eq!(byte_length as usize, output.len());
        assert!(lines[1].ends_with("WaitSamples(1)"));
        assert!(lines.last().unwrap().ends_with("EndOfData"));
        assert!(
            write_parse_output(
                &root,
                "reports/full-vgm-parse.txt",
                "VGM parse output",
                |file| file.write_all(b"replacement"),
            )
            .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn mdx_tool_writes_all_tracks_in_soundlog_mdx_parse_format() {
        let source = format!("A r4 {}\nB d4", vec!["c4"; MAX_COMMANDS + 1].join(" "));
        let parsed = mmlx::mdx::frontend::parse(&source).unwrap();
        let mdx = mmlx::mdx::frontend::compile(&parsed)
            .unwrap()
            .into_document();
        let command_count = mdx.tracks.iter().map(Vec::len).sum::<usize>();
        let bytes = mdx.to_bytes().unwrap();
        let root = test_workspace();
        fs::write(root.join("input.mdx"), &bytes).unwrap();
        let input = read_binary_input(&root, "input.mdx").unwrap();
        let document = MdxDocument::parse(&input).unwrap();
        let source_map = document.sourcemap().unwrap();
        let (written_commands, byte_length) = write_parse_output(
            &root,
            "reports/full-mdx-parse.txt",
            "MDX parse output",
            |file| write_mdx_parse(&document, &source_map, file),
        )
        .unwrap();
        let output = fs::read_to_string(root.join("reports/full-mdx-parse.txt")).unwrap();
        let lines = output.lines().collect::<Vec<_>>();
        assert_eq!(
            lines[0],
            format!(
                "{:<8} {:<8} {:<8} {:<8} Command",
                "Track", "Index", "Offset", "Length"
            )
        );
        assert_eq!(lines.len(), command_count + 1);
        assert_eq!(written_commands, command_count);
        assert_eq!(byte_length as usize, output.len());
        assert!(lines.iter().any(|line| line.starts_with("1       ")));
        assert!(lines[1].contains("Rest("));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn vgm_stream_writes_soundlog_style_rows_to_a_new_file() {
        let mut builder = soundlog::VgmBuilder::new();
        builder.add_vgm_command(WaitSamples(12));
        let bytes: Vec<u8> = builder.finalize().into();
        let header = VgmHeader::from_bytes(&bytes).unwrap();
        let stream = VgmStream::from_vgm(bytes.clone()).unwrap();
        let root = test_workspace();
        let (command_count, byte_length) = write_stream_output(
            &root,
            "reports/vgm-stream.txt",
            "VGM stream output",
            stream,
            |callback_stream| callback_stream.track_chips(&header.chip_instances()),
        )
        .unwrap();
        let output = fs::read_to_string(root.join("reports/vgm-stream.txt")).unwrap();
        let lines = output.lines().collect::<Vec<_>>();
        assert_eq!(
            lines[0],
            "Samples      Register Write                           Events"
        );
        assert_eq!(lines.len(), command_count + 1);
        assert!(lines.iter().any(|line| line.contains("WaitSamples(12)")));
        assert_eq!(byte_length as usize, output.len());
        assert!(
            write_stream_output(
                &root,
                "reports/vgm-stream.txt",
                "VGM stream output",
                VgmStream::from_vgm(bytes).unwrap(),
                |_| {},
            )
            .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn mdx_stream_accepts_mml_and_writes_playback_register_rows() {
        let root = test_workspace();
        fs::write(root.join("song.mml"), "A t120 o4 c4").unwrap();
        let (package, pdx_path) = load_mdx_stream_package(&root, "song.mml", None).unwrap();
        assert!(pdx_path.is_none());
        let options = MdxToVgmOptions {
            loop_count: Some(1),
            max_ticks: Some(100_000),
            ..Default::default()
        };
        let generator = to_vgm_stream_generator(package, options).unwrap();
        let stream = VgmStream::from_generator(generator);
        let (command_count, byte_length) = write_stream_output(
            &root,
            "reports/mdx-stream.txt",
            "MDX stream output",
            stream,
            |callback_stream| {
                use soundlog::chip::state::Ym2151State;

                callback_stream.track_state::<Ym2151State>(Instance::Primary, 4_000_000.0);
            },
        )
        .unwrap();
        let output = fs::read_to_string(root.join("reports/mdx-stream.txt")).unwrap();
        let lines = output.lines().collect::<Vec<_>>();
        assert_eq!(
            lines[0],
            "Samples      Register Write                           Events"
        );
        assert!(command_count > 0);
        assert_eq!(lines.len(), command_count + 1);
        assert!(output.contains("Ym2151Write"));
        assert!(output.contains("KeyOn("));
        assert_eq!(byte_length as usize, output.len());
        fs::remove_dir_all(root).unwrap();
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
