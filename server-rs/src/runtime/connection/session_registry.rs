use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::edge::socket::events::{
    character_room, sect_room, team_room, user_room, CHAT_AUTHED_ROOM,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RealtimeSession {
    pub socket_id: String,
    pub user_id: i64,
    pub session_token: String,
    pub character_id: Option<i64>,
    pub team_id: Option<String>,
    pub sect_id: Option<String>,
    pub last_update_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionInsertResult {
    pub replaced_socket_id: Option<String>,
    pub joined_rooms: Vec<String>,
}

#[derive(Debug, Default)]
pub struct SessionRegistry {
    sessions_by_socket: HashMap<String, RealtimeSession>,
    user_socket_map: HashMap<i64, String>,
    character_socket_map: HashMap<i64, String>,
}

pub type SharedSessionRegistry = Arc<Mutex<SessionRegistry>>;

pub fn new_shared_session_registry() -> SharedSessionRegistry {
    Arc::new(Mutex::new(SessionRegistry::new()))
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, session: RealtimeSession) -> SessionInsertResult {
        if self.sessions_by_socket.contains_key(&session.socket_id) {
            self.remove(&session.socket_id);
        }

        let replaced_socket_id = self.user_socket_map.get(&session.user_id).cloned();

        if let Some(previous_socket_id) = replaced_socket_id.as_ref() {
            if previous_socket_id != &session.socket_id {
                self.remove(previous_socket_id);
            }
        }

        self.user_socket_map
            .insert(session.user_id, session.socket_id.clone());

        if let Some(character_id) = session.character_id {
            self.character_socket_map
                .insert(character_id, session.socket_id.clone());
        }

        let joined_rooms = build_join_rooms(&session);
        self.sessions_by_socket
            .insert(session.socket_id.clone(), session);

        SessionInsertResult {
            replaced_socket_id: replaced_socket_id,
            joined_rooms,
        }
    }

    pub fn remove(&mut self, socket_id: &str) -> Option<RealtimeSession> {
        let removed = self.sessions_by_socket.remove(socket_id)?;
        if self
            .user_socket_map
            .get(&removed.user_id)
            .is_some_and(|value| value == socket_id)
        {
            self.user_socket_map.remove(&removed.user_id);
        }
        if let Some(character_id) = removed.character_id {
            if self
                .character_socket_map
                .get(&character_id)
                .is_some_and(|value| value == socket_id)
            {
                self.character_socket_map.remove(&character_id);
            }
        }
        Some(removed)
    }

    pub fn get_by_socket(&self, socket_id: &str) -> Option<&RealtimeSession> {
        self.sessions_by_socket.get(socket_id)
    }

    pub fn socket_id_by_user(&self, user_id: i64) -> Option<&str> {
        self.user_socket_map.get(&user_id).map(String::as_str)
    }

    pub fn socket_id_by_character(&self, character_id: i64) -> Option<&str> {
        self.character_socket_map
            .get(&character_id)
            .map(String::as_str)
    }

    pub fn len(&self) -> usize {
        self.sessions_by_socket.len()
    }
}

fn build_join_rooms(session: &RealtimeSession) -> Vec<String> {
    let mut rooms = Vec::with_capacity(5);
    rooms.push(CHAT_AUTHED_ROOM.to_string());
    rooms.push(user_room(session.user_id));
    if let Some(character_id) = session.character_id {
        rooms.push(character_room(character_id));
    }
    if let Some(team_id) = session.team_id.as_deref() {
        rooms.push(team_room(team_id));
    }
    if let Some(sect_id) = session.sect_id.as_deref() {
        rooms.push(sect_room(sect_id));
    }
    rooms
}
