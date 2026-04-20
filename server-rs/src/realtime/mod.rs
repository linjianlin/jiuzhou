pub mod battle;
pub mod public_socket;
pub mod achievement;
pub mod arena;
pub mod chat;
pub mod game_time;
pub mod online_players;
pub mod idle;
pub mod mail;
pub mod market;
pub mod partner;
pub mod partner_fusion;
pub mod partner_recruit;
pub mod partner_rebone;
pub mod rank;
pub mod realm;
pub mod sign_in;
pub mod socket_protocol;
pub mod sect;
pub mod task;
pub mod team;
pub mod technique_research;
pub mod wander;

#[derive(Debug, Clone, Default)]
pub struct RealtimeRuntime;

impl RealtimeRuntime {
    pub fn new() -> Self {
        Self
    }

    pub async fn initialize(&self) -> anyhow::Result<()> {
        tracing::info!("realtime runtime initialized; public socket path is mounted by the HTTP app router");
        Ok(())
    }

    pub async fn shutdown(&self) {
        tracing::info!("realtime runtime stopped");
    }
}
