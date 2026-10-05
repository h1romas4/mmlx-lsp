use crate::dialect::Dialect;
use lsp_types::InitializeParams;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Language {
    #[default]
    Japanese,
    English,
}

impl Language {
    pub fn locale(self) -> &'static str {
        match self {
            Self::Japanese => "ja",
            Self::English => "en",
        }
    }

    pub fn from_initialize(params: &InitializeParams) -> Self {
        params
            .initialization_options
            .as_ref()
            .and_then(|options| options.get("language"))
            .and_then(|language| language.as_str())
            .and_then(Self::parse)
            .or_else(|| params.locale.as_deref().and_then(Self::parse))
            .unwrap_or_default()
    }

    fn parse(locale: &str) -> Option<Self> {
        match locale
            .split(['-', '_'])
            .next()?
            .to_ascii_lowercase()
            .as_str()
        {
            "ja" => Some(Self::Japanese),
            "en" => Some(Self::English),
            _ => None,
        }
    }
}

pub fn translate(language: Language, key: &str) -> String {
    rust_i18n::t!(key, locale = language.locale()).to_string()
}

pub fn command_text(
    language: Language,
    dialect: Dialect,
    label: &str,
    parameter_count: usize,
) -> (String, String, Vec<String>) {
    let key = format!("{}.commands.{label}", dialect.id());
    (
        translate(language, &format!("{key}.syntax")),
        translate(language, &format!("{key}.description")),
        (0..parameter_count)
            .map(|index| translate(language, &format!("{key}.parameters.p{index}")))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet};

    fn catalog(source: &str) -> BTreeMap<String, String> {
        fn collect(
            value: &serde_json::Value,
            prefix: &str,
            entries: &mut BTreeMap<String, String>,
        ) {
            match value {
                serde_json::Value::Object(fields) => {
                    for (key, value) in fields {
                        if prefix.is_empty() && key == "_version" {
                            continue;
                        }
                        let key = if prefix.is_empty() {
                            key.clone()
                        } else {
                            format!("{prefix}.{key}")
                        };
                        collect(value, &key, entries);
                    }
                }
                serde_json::Value::String(text) => {
                    assert!(!text.trim().is_empty(), "Empty translation: {prefix}");
                    assert!(entries.insert(prefix.into(), text.clone()).is_none());
                }
                _ => panic!("Translation must be a string: {prefix}"),
            }
        }
        let value = serde_saphyr::from_str(source).unwrap();
        let mut entries = BTreeMap::new();
        collect(&value, "", &mut entries);
        entries
    }

    #[test]
    fn catalogs_have_matching_keys_and_embedded_values() {
        let japanese = catalog(include_str!("../locales/ja.yml"));
        let english = catalog(include_str!("../locales/en.yml"));
        assert!(japanese.contains_key("mdx.commands.t.description"));
        assert!(japanese.contains_key("mdx.voice_definition.label"));
        assert!(japanese.keys().all(|key| {
            key.starts_with("mdx.") || key.starts_with("ui.") || key.starts_with("server.")
        }));
        assert_eq!(
            japanese.keys().collect::<Vec<_>>(),
            english.keys().collect::<Vec<_>>()
        );
        for (language, catalog) in [(Language::Japanese, japanese), (Language::English, english)] {
            for (key, expected) in catalog {
                let normalized_text = expected.to_ascii_lowercase();
                assert!(
                    !["soundlog", "mmlx"]
                        .into_iter()
                        .any(|name| normalized_text.contains(name)),
                    "{}: {key} contains an implementation name",
                    language.locale()
                );
                assert_eq!(
                    translate(language, &key),
                    expected,
                    "{}: {key}",
                    language.locale()
                );
            }
        }
        let locales: BTreeSet<_> = rust_i18n::available_locales!()
            .iter()
            .map(|locale| locale.to_string())
            .collect();
        assert_eq!(locales, BTreeSet::from(["en".into(), "ja".into()]));
    }

    #[test]
    fn unsupported_locale_falls_back_to_japanese() {
        assert_eq!(rust_i18n::t!("ui.example", locale = "fr"), "例");
        assert_eq!(rust_i18n::t!("ui.example", locale = "en-US"), "Example");
    }

    #[test]
    fn explicit_locales_remain_independent_across_threads() {
        std::thread::scope(|scope| {
            for (language, expected) in [
                (Language::Japanese, "@ 音色定義"),
                (Language::English, "@ Voice definition"),
            ] {
                scope.spawn(move || {
                    for _ in 0..100 {
                        assert_eq!(translate(language, "mdx.voice_definition.label"), expected);
                    }
                });
            }
        });
    }

    #[test]
    fn explicit_language_overrides_locale_with_a_japanese_fallback() {
        for (locale, language, expected) in [
            (Some("en-US"), Some("ja"), Language::Japanese),
            (Some("ja-JP"), Some("en"), Language::English),
            (Some("en_US"), Some("auto"), Language::English),
            (Some("JA-jp"), None, Language::Japanese),
            (Some("en-GB"), Some("unknown"), Language::English),
            (Some("fr-FR"), None, Language::Japanese),
            (None, None, Language::Japanese),
        ] {
            let params: InitializeParams = serde_json::from_value(serde_json::json!({
                "capabilities": {}, "locale": locale,
                "initializationOptions": { "language": language }
            }))
            .unwrap();
            assert_eq!(Language::from_initialize(&params), expected);
        }
    }
}
