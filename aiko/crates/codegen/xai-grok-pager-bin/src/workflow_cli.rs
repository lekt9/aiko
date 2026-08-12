//! Dependency-small parser for `aiko workflow`.
//!
//! Keep this file `std`-only: the acceptance witness compiles its exact source
//! with `rustc --test`, without linking the full pager binary.

use std::ffi::OsString;

pub const API_VERSION: &str = "aiko.workflow/v1";
pub const SUBJECTIVE_ACCEPTANCE: &str = "subjective-independent-edge-review/v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkflowCommand {
    Schema {
        operation: Option<String>,
    },
    Route {
        goal: String,
    },
    Submit {
        goal: String,
        acceptance_mode: String,
        bundle_ref: Option<String>,
    },
    Status {
        bundle_ref: String,
    },
    Inspect {
        bundle_ref: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceRequestParts {
    pub operation: &'static str,
    pub goal: Option<String>,
    pub bundle_ref: Option<String>,
    pub acceptance_mode: Option<String>,
}

impl WorkflowCommand {
    /// Typed dispatch mapping consumed by the composition root. Schema is
    /// catalog-only and therefore has no workflow service request.
    pub fn service_request(&self) -> Option<ServiceRequestParts> {
        match self {
            Self::Schema { .. } => None,
            Self::Route { goal } => Some(ServiceRequestParts {
                operation: "route",
                goal: Some(goal.clone()),
                bundle_ref: None,
                acceptance_mode: None,
            }),
            Self::Submit {
                goal,
                acceptance_mode,
                bundle_ref,
            } => Some(ServiceRequestParts {
                operation: "submit",
                goal: Some(goal.clone()),
                bundle_ref: bundle_ref.clone(),
                acceptance_mode: Some(acceptance_mode.clone()),
            }),
            Self::Status { bundle_ref } => Some(ServiceRequestParts {
                operation: "status",
                goal: None,
                bundle_ref: Some(bundle_ref.clone()),
                acceptance_mode: None,
            }),
            Self::Inspect { bundle_ref } => Some(ServiceRequestParts {
                operation: "inspect",
                goal: None,
                bundle_ref: Some(bundle_ref.clone()),
                acceptance_mode: None,
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub code: &'static str,
    pub message: String,
}

/// Render the stable one-line CLI refusal envelope without pulling the pager's
/// dependency graph into parser witnesses.
pub fn error_json(operation: &str, code: &str, message: &str) -> String {
    format!(
        "{{\"api_version\":\"{}\",\"operation\":{},\"ok\":false,\"error\":{{\"code\":{},\"message\":{},\"retryable\":false}}}}",
        API_VERSION,
        json_string(operation),
        json_string(code),
        json_string(message),
    )
}

fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if ch < ' ' => {
                use std::fmt::Write as _;
                write!(&mut out, "\\u{:04x}", ch as u32).expect("String writes cannot fail");
            }
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

pub fn parse_from<I>(args: I) -> Result<Option<WorkflowCommand>, ParseError>
where
    I: IntoIterator<Item = OsString>,
{
    let args = args.into_iter().collect::<Vec<_>>();
    if args.get(1).and_then(|value| value.to_str()) != Some("workflow") {
        return Ok(None);
    }
    let text = args
        .iter()
        .skip(2)
        .map(|value| {
            value.to_str().map(str::to_owned).ok_or_else(|| ParseError {
                code: "workflow_cli_invalid_utf8",
                message: "workflow arguments must be UTF-8".to_owned(),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let Some(subcommand) = text.first().map(String::as_str) else {
        return Err(usage("missing workflow subcommand"));
    };
    match subcommand {
        "schema" => {
            if text.len() > 2 {
                return Err(usage("schema accepts at most one operation"));
            }
            let operation = text.get(1).cloned();
            if let Some(name) = operation.as_deref()
                && !matches!(name, "route" | "submit" | "status" | "inspect")
            {
                return Err(usage(format!("unsupported schema operation {name}")));
            }
            Ok(Some(WorkflowCommand::Schema { operation }))
        }
        "route" => Ok(Some(WorkflowCommand::Route {
            goal: one_value(&text, "route", "goal", "--goal")?,
        })),
        "submit" => {
            let (goal, acceptance_mode, bundle_ref) = submit_values(&text)?;
            Ok(Some(WorkflowCommand::Submit {
                goal,
                acceptance_mode,
                bundle_ref,
            }))
        }
        "status" => Ok(Some(WorkflowCommand::Status {
            bundle_ref: one_value(&text, "status", "bundle_ref", "--bundle-ref")?,
        })),
        "inspect" => Ok(Some(WorkflowCommand::Inspect {
            bundle_ref: one_value(&text, "inspect", "bundle_ref", "--bundle-ref")?,
        })),
        other => Err(usage(format!("unsupported workflow subcommand {other}"))),
    }
}

fn submit_values(args: &[String]) -> Result<(String, String, Option<String>), ParseError> {
    let (goal, acceptance_mode, bundle_ref) = match args {
        [_, goal, acceptance_flag, acceptance_mode] if acceptance_flag == "--acceptance" => {
            (goal, acceptance_mode, None)
        }
        [_, goal_flag, goal, acceptance_flag, acceptance_mode]
            if goal_flag == "--goal" && acceptance_flag == "--acceptance" =>
        {
            (goal, acceptance_mode, None)
        }
        [
            _,
            goal,
            acceptance_flag,
            acceptance_mode,
            bundle_flag,
            bundle_ref,
        ] if acceptance_flag == "--acceptance" && bundle_flag == "--bundle-ref" => {
            (goal, acceptance_mode, Some(bundle_ref))
        }
        [
            _,
            goal_flag,
            goal,
            acceptance_flag,
            acceptance_mode,
            bundle_flag,
            bundle_ref,
        ] if goal_flag == "--goal"
            && acceptance_flag == "--acceptance"
            && bundle_flag == "--bundle-ref" =>
        {
            (goal, acceptance_mode, Some(bundle_ref))
        }
        _ => {
            return Err(usage(
                "submit requires goal plus --acceptance subjective-independent-edge-review/v1 and accepts optional --bundle-ref",
            ));
        }
    };
    let goal = goal.trim();
    if goal.is_empty() {
        return Err(usage("submit requires a non-empty goal"));
    }
    if acceptance_mode.trim() != SUBJECTIVE_ACCEPTANCE {
        return Err(usage(
            "only subjective-independent-edge-review/v1 is supported; objective workflows need an admitted acceptance profile",
        ));
    }
    let bundle_ref = bundle_ref
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    if bundle_ref.as_deref().is_some_and(|value| {
        value.strip_prefix("cas:").is_none_or(|digest| {
            digest.len() != 64
                || !digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        })
    }) {
        return Err(usage("submit --bundle-ref must be cas:<lowercase-sha256>"));
    }
    Ok((
        goal.to_owned(),
        acceptance_mode.trim().to_owned(),
        bundle_ref,
    ))
}

fn one_value(
    args: &[String],
    operation: &str,
    field: &str,
    flag: &str,
) -> Result<String, ParseError> {
    let value = match args {
        [_, value] => value,
        [_, supplied_flag, value] if supplied_flag == flag => value,
        _ => {
            return Err(usage(format!(
                "{operation} requires exactly one non-empty {field}"
            )));
        }
    };
    let value = value.trim();
    if value.is_empty() {
        return Err(usage(format!(
            "{operation} requires exactly one non-empty {field}"
        )));
    }
    Ok(value.to_owned())
}

fn usage(message: impl Into<String>) -> ParseError {
    ParseError {
        code: "workflow_cli_usage",
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Option<WorkflowCommand>, ParseError> {
        parse_from(args.iter().map(OsString::from))
    }

    #[test]
    fn prompt_cli_is_not_claimed() {
        assert_eq!(parse(&["aiko", "fix the bug"]).unwrap(), None);
        assert_eq!(parse(&["aiko", "agent", "stdio"]).unwrap(), None);
    }

    #[test]
    fn parses_every_truthful_operation() {
        assert_eq!(
            parse(&["aiko", "workflow", "route", "--goal", "join results"]).unwrap(),
            Some(WorkflowCommand::Route {
                goal: "join results".into()
            })
        );
        assert_eq!(
            parse(&[
                "aiko",
                "workflow",
                "submit",
                "do work",
                "--acceptance",
                SUBJECTIVE_ACCEPTANCE
            ])
            .unwrap(),
            Some(WorkflowCommand::Submit {
                goal: "do work".into(),
                acceptance_mode: SUBJECTIVE_ACCEPTANCE.into(),
                bundle_ref: None,
            })
        );
        assert_eq!(
            parse(&[
                "aiko",
                "workflow",
                "submit",
                "--goal",
                "do work",
                "--acceptance",
                SUBJECTIVE_ACCEPTANCE,
                "--bundle-ref",
                "cas:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ])
            .unwrap(),
            Some(WorkflowCommand::Submit {
                goal: "do work".into(),
                acceptance_mode: SUBJECTIVE_ACCEPTANCE.into(),
                bundle_ref: Some(
                    "cas:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into()
                ),
            })
        );
        assert!(matches!(
            parse(&["aiko", "workflow", "status", "sha256:abc"]).unwrap(),
            Some(WorkflowCommand::Status { .. })
        ));
        assert!(matches!(
            parse(&["aiko", "workflow", "inspect", "--bundle-ref", "sha256:def"]).unwrap(),
            Some(WorkflowCommand::Inspect { .. })
        ));
        assert_eq!(
            parse(&["aiko", "workflow", "schema", "route"]).unwrap(),
            Some(WorkflowCommand::Schema {
                operation: Some("route".into())
            })
        );
    }

    #[test]
    fn unsupported_and_extra_authority_are_closed() {
        for args in [
            vec!["aiko", "workflow", "prepare", "x"],
            vec!["aiko", "workflow", "find", "x"],
            vec!["aiko", "workflow", "submit", "objective work"],
            vec![
                "aiko",
                "workflow",
                "submit",
                "objective work",
                "--acceptance",
                "objective-artifact/v1",
            ],
            vec!["aiko", "workflow", "submit", "x", "--rollout", "observe"],
            vec!["aiko", "workflow", "status", "x", "--state-root", "/tmp/y"],
        ] {
            assert_eq!(parse(&args).unwrap_err().code, "workflow_cli_usage");
        }
    }

    #[test]
    fn dispatch_mapping_preserves_typed_explicit_workflow_fields() {
        let submit = parse(&[
            "aiko",
            "workflow",
            "submit",
            "do work",
            "--acceptance",
            SUBJECTIVE_ACCEPTANCE,
        ])
        .unwrap()
        .unwrap()
        .service_request()
        .unwrap();
        assert_eq!(submit.operation, "submit");
        assert_eq!(submit.goal.as_deref(), Some("do work"));
        assert_eq!(submit.bundle_ref, None);
        assert_eq!(
            submit.acceptance_mode.as_deref(),
            Some(SUBJECTIVE_ACCEPTANCE)
        );

        let status = parse(&["aiko", "workflow", "status", "sha256:abc"])
            .unwrap()
            .unwrap()
            .service_request()
            .unwrap();
        assert_eq!(status.operation, "status");
        assert_eq!(status.goal, None);
        assert_eq!(status.bundle_ref.as_deref(), Some("sha256:abc"));
    }

    #[test]
    fn refusal_json_is_one_versioned_closed_line() {
        assert_eq!(
            error_json("cli_parse", "workflow_cli_usage", "bad \"field\"\n"),
            "{\"api_version\":\"aiko.workflow/v1\",\"operation\":\"cli_parse\",\"ok\":false,\"error\":{\"code\":\"workflow_cli_usage\",\"message\":\"bad \\\"field\\\"\\n\",\"retryable\":false}}"
        );
    }
}
