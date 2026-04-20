use tracing_subscriber::fmt::format::FmtSpan;
use tracing_subscriber::EnvFilter;

pub fn init_tracing(level: &str, node_env: &str) -> anyhow::Result<()> {
    let env_filter = EnvFilter::try_from_default_env()
        .or_else(|_| EnvFilter::try_new(level))
        .unwrap_or_else(|_| EnvFilter::new("info"));

    let builder = tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_span_events(FmtSpan::CLOSE)
        .with_target(false);

    if node_env.eq_ignore_ascii_case("production") {
        builder
            .json()
            .try_init()
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    } else {
        builder
            .pretty()
            .try_init()
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    }

    Ok(())
}
