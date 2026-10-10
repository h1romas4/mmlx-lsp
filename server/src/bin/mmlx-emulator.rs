fn main() {
    if let Err(error) =
        mmlx_lsp_server::emulation::protocol::run(std::io::stdin().lock(), std::io::stdout().lock())
    {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(target_arch = "wasm32")]
mod browser {
    use mmlx_lsp_server::emulation::protocol::{Session, frame};
    use std::cell::RefCell;

    #[derive(Default)]
    struct BrowserSession {
        session: Session,
        input: Vec<u8>,
        output: Vec<u8>,
    }

    thread_local! {
        static STATE: RefCell<BrowserSession> = RefCell::new(BrowserSession::default());
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn emulation_input(length: usize) -> usize {
        if length == 0 || length > 2 * 1024 * 1024 {
            return 0;
        }
        STATE.with_borrow_mut(|state| {
            state.input.resize(length, 0);
            state.input.as_mut_ptr() as usize
        })
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn emulation_execute() -> usize {
        STATE.with_borrow_mut(|state| {
            let BrowserSession {
                session,
                input,
                output,
            } = state;
            output.clear();
            if let Err(error) = session.execute(input, &mut *output) {
                output.clear();
                let _ = frame(output, 7, error.as_bytes());
            }
            output.len()
        })
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn emulation_output() -> usize {
        STATE.with_borrow(|state| state.output.as_ptr() as usize)
    }
}
