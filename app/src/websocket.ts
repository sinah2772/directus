import { MessageCallback, MessageType, SubscribeOptions, WebSocketClient, WebSocketWrapper } from '@directus/shared/types';
import api from './api';

let uidCounter = (function*() {
    let i = 0;
    while(true) {
        yield i++;
    }
})();

let ws: WebSocket | null = null
let authenticated = false

const onMessageCallbacks = new Map<number, MessageCallback>()
const onAuthCallbacks = new Set<() => void>()
const oncloseCallbacks = new Set<() => void>()


function connectWebSocket() {
    if(ws !== null) return ws

    ws = new WebSocket("ws://localhost:8055/websocket")

    ws.onopen = async () => {
        if(ws === null) return;
        await authenticate(ws)
    }

    ws.onmessage = (event) => {
        if(ws === null) return
        
        const message = JSON.parse(event.data);
        const type = message['type'].toUpperCase()
        const uid = 'uid' in message? Number(message['uid']) : undefined;
    
        console.log("messageRecieved", message)
    
        switch(type) {
            case 'PING':
                ws.send(JSON.stringify({type: 'PONG'}))
                break;
        }
        if(uid) {
            const callback = onMessageCallbacks.get(uid)
            if(callback) callback(message)
        }
    }

    ws.onclose = () => {
        ws = null
        oncloseCallbacks.forEach((callback) => callback())
        setTimeout(() => {
            connectWebSocket()
        }, 1_000)
    }

    ws.onerror = (error) => {
        console.error(error)
        ws?.close()
    }

    
}

async function authenticate(ws: WebSocket) {
    let token = api.defaults.headers.common['Authorization']?.substring(7)
    const client = new Client(ws)

    if(!token) return

    console.log("Authenticating with token", token)

    try {
        authenticated = true;

        const response = await client.send('AUTH', {
            access_token: token
        })
        console.log("Authenticated", response)

        if(response['status'] === 'ok') {
            onAuthCallbacks.forEach((callback) => callback())
        }

        if(response['status'] === 'error') {
            console.error("Authentication failed", response['error'])
            authenticated = false;
        }
    } catch(error) {
        console.error(error)
        authenticated = false
    }
}

connectWebSocket()

export function getWebSocket() {
    return new Wrapper(ws!)
}

class Wrapper implements WebSocketWrapper {
    connectCallbacks = new Set<(client: WebSocketClient) => void>()
    disconnectCallbacks = new Set<() => void>()
    ws: WebSocket
    client: WebSocketClient

    constructor(ws: WebSocket) {
        this.ws = ws
        this.client = new Client(ws)

        onAuthCallbacks.add(() => {
            this.connectCallbacks.forEach((callback) => callback(this.client))
        })
        oncloseCallbacks.add(() => {
            this.disconnectCallbacks.forEach((callback) => callback())
        })
    }

    onConnect(callback: (client: WebSocketClient) => void) {
        this.connectCallbacks.add(callback)

        if(authenticated) {
            callback(this.client)
        }
    }

    onDisconnect(callback: () => void) {
        this.disconnectCallbacks.add(callback)
    }
    
}

class Client implements WebSocketClient {
    ws: WebSocket
    
    constructor(ws: WebSocket) {
        this.ws = ws
    }

    subscribe(options: SubscribeOptions, callback: MessageCallback) {
        const counter = uidCounter.next().value;
    
        onMessageCallbacks.set(counter, callback)
        const data: Record<string, any> = { 
            type: 'SUBSCRIBE',
            collection: options.collection,
            uid: counter
        }

        if(options.item) data['item'] = options.item;
        if(options.query) data['query'] = options.query;

        this.ws.send(JSON.stringify(data));
    
        return counter;
    }
    
    unsubscribe(uid: number) {
        onMessageCallbacks.delete(uid);
        this.ws.send(JSON.stringify({ type: 'UNSUBSCRIBE', uid }));
    }
    
    send(type: MessageType, data: Record<string, any> = {}, timeout: number = 5000) {
        const counter = uidCounter.next().value;
    
        return new Promise<Record<string, any>>((resolve, reject) => {
            onMessageCallbacks.set(counter, (data) => {
                onMessageCallbacks.delete(counter);
                resolve(data)
            })
    
            setTimeout(() => {
                reject(new Error(`Timeout while waiting for ${type} response`))
            }, timeout)
    
            this.ws.send(JSON.stringify({ ...data, type, uid: counter }));
        })
    }
}