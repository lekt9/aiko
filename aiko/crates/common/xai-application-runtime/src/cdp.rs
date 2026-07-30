use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{Mutex, broadcast, oneshot};
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Clone)]
pub(crate) struct Event {
    pub method: String,
    pub params: Value,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;
type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Minimal asynchronous Chrome DevTools Protocol transport.
///
/// This is intentionally Aiko-owned. It contains only request correlation,
/// event fan-out, and connection liveness needed by the application runtime.
pub(crate) struct Client {
    writer: Arc<Mutex<futures_util::stream::SplitSink<Socket, Message>>>,
    pending: Pending,
    events: broadcast::Sender<Event>,
    next_id: AtomicU64,
    reader: tokio::task::JoinHandle<()>,
}

impl Client {
    pub async fn connect(url: &str) -> Result<Self, String> {
        let (socket, _) = tokio_tungstenite::connect_async(url)
            .await
            .map_err(|error| format!("CDP connection failed: {error}"))?;
        let (writer, mut reader) = socket.split();
        let writer = Arc::new(Mutex::new(writer));
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (events, _) = broadcast::channel(4096);
        let reader_pending = pending.clone();
        let reader_events = events.clone();

        let reader = tokio::spawn(async move {
            while let Some(message) = reader.next().await {
                let text = match message {
                    Ok(Message::Text(text)) => text.to_string(),
                    Ok(Message::Binary(bytes)) => {
                        let Ok(text) = String::from_utf8(bytes.to_vec()) else {
                            continue;
                        };
                        text
                    }
                    Ok(Message::Ping(_) | Message::Pong(_)) => continue,
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => continue,
                };
                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                if let Some(id) = value.get("id").and_then(Value::as_u64) {
                    let result = if let Some(error) = value.get("error") {
                        Err(error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown CDP error")
                            .to_owned())
                    } else {
                        Ok(value.get("result").cloned().unwrap_or(Value::Null))
                    };
                    if let Some(sender) = reader_pending.lock().await.remove(&id) {
                        let _ = sender.send(result);
                    }
                } else if let Some(method) = value.get("method").and_then(Value::as_str) {
                    let _ = reader_events.send(Event {
                        method: method.to_owned(),
                        params: value.get("params").cloned().unwrap_or(Value::Null),
                    });
                }
            }
            reader_pending.lock().await.clear();
        });

        Ok(Self {
            writer,
            pending,
            events,
            next_id: AtomicU64::new(1),
            reader,
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    pub async fn command(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        let payload = json!({
            "id": id,
            "method": method,
            "params": params,
        });
        if let Err(error) = self
            .writer
            .lock()
            .await
            .send(Message::Text(payload.to_string().into()))
            .await
        {
            self.pending.lock().await.remove(&id);
            return Err(format!("CDP send failed: {error}"));
        }
        match tokio::time::timeout(Duration::from_secs(30), receiver).await {
            Ok(Ok(result)) => result.map_err(|error| format!("{method}: {error}")),
            Ok(Err(_)) => Err(format!("{method}: CDP connection closed")),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("{method}: timed out"))
            }
        }
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        self.reader.abort();
    }
}
