use iroh::{Endpoint, EndpointAddr, endpoint::presets};

const ALPN: &[u8] = b"aiko/collective-iroh-spike/1";
const OBJECT: &[u8] = b"blake3:verified-aiko-object";

async fn endpoint(serves: bool) -> Result<Endpoint, Box<dyn std::error::Error>> {
    let mut builder = Endpoint::builder(presets::Minimal);
    if serves {
        builder = builder.alpns(vec![ALPN.to_vec()]);
    }
    Ok(builder.bind().await?)
}

async fn serve_once(server: Endpoint, expected: &'static [u8]) -> Result<(), String> {
    let incoming = server.accept().await.ok_or("endpoint closed")?;
    let connection = incoming.await.map_err(|error| error.to_string())?;
    let (mut send, mut receive) = connection
        .accept_bi()
        .await
        .map_err(|error| error.to_string())?;
    let request = receive
        .read_to_end(256)
        .await
        .map_err(|error| error.to_string())?;
    if request != b"GET_OBJECT" {
        return Err("unexpected request".into());
    }
    send.write_all(expected)
        .await
        .map_err(|error| error.to_string())?;
    send.finish().map_err(|error| error.to_string())?;
    connection.closed().await;
    Ok(())
}

async fn fetch(
    client: &Endpoint,
    provider: EndpointAddr,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let connection = client.connect(provider, ALPN).await?;
    let (mut send, mut receive) = connection.open_bi().await?;
    send.write_all(b"GET_OBJECT").await?;
    send.finish()?;
    let bytes = receive.read_to_end(256).await?;
    connection.close(0_u32.into(), b"object received");
    Ok(bytes)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Minimal has no relay, DNS publisher, discovery service, or hosted
    // dependency. Node B fetches from A, A leaves, then C fetches the retained
    // bytes from B. This measures Iroh's transport primitive only.
    let node_a = endpoint(true).await?;
    let node_b_client = endpoint(false).await?;
    let serve_a = tokio::spawn(serve_once(node_a.clone(), OBJECT));
    let retained = fetch(&node_b_client, node_a.addr()).await?;
    serve_a.await??;
    node_a.close().await;
    node_b_client.close().await;

    if retained != OBJECT {
        return Err("node B retained corrupt bytes".into());
    }

    let node_b = endpoint(true).await?;
    let node_c = endpoint(false).await?;
    let served = Box::leak(retained.into_boxed_slice());
    let serve_b = tokio::spawn(serve_once(node_b.clone(), served));
    let recovered = fetch(&node_c, node_b.addr()).await?;
    serve_b.await??;

    node_b.close().await;
    node_c.close().await;
    if recovered != OBJECT {
        return Err("node C recovered corrupt bytes".into());
    }
    println!("iroh-minimal three-node offline handoff: ok");
    Ok(())
}
