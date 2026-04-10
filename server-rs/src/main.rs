#[tokio::main]
async fn main() {
    if let Err(error) = jiuzhou_server_rs::run().await {
        eprintln!("Rust server exited with error: {error}");
        std::process::exit(1);
    }
}
