rust_i18n::i18n!("locales", fallback = "ja");

#[cfg(any(feature = "emulation", feature = "nanodrive"))]
pub mod audition;
pub mod build;
pub mod completion;
pub mod diagnostics;
pub mod dialect;
#[cfg(feature = "emulation")]
pub mod emulation;
pub mod formatter;
pub mod i18n;
#[cfg(feature = "nanodrive")]
pub mod nanodrive;
pub mod playback;
pub mod selection_range;
pub mod semantic;
pub mod track_length;
pub mod voice;
