fn main() {
    if let Err(error) =
        mmlx_lsp_server::emulation::protocol::run(std::io::stdin().lock(), std::io::stdout().lock())
    {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
