import { Query } from '@directus/shared/types';
import api from './api';

const messageTypes = ['SUBSCRIBE', 'UNSUBSCRIBE', 'PING', 'PONG', 'AUTH','HANDSHAKE'] as const;
type MessageType = typeof messageTypes[number]

type MessageCallback = (data: Record<string, any>) => void;

type WSQuery = Query & {
    status?: boolean,
    event?: string | string[],
}

interface SubscribeOptions {
    collection: string,
    item?: string | number,
    query?: WSQuery,
}

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
        const client = new WebSocketClient(ws)
        await authenticate(client)
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

async function authenticate(client: WebSocketClient) {
    let token = api.defaults.headers.common['Authorization'].substring(7)

    console.log("Authenticating with token", token)

    try {
        authenticated = true;

        const response = await client.send('HANDSHAKE', {
            access_token: token
        })
        console.log("Authenticated", response)

        if(response['status'] === 'ok') {
            onAuthCallbacks.forEach((callback) => callback())
        }

        if(response['status'] === 'error' && false) {
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
    return new WebSocketClient(ws!)
}

class WebSocketClient {
    ws: WebSocket
    connectCallbacks = new Set<(client: WebSocketClient) => void>()
    disconnectCallbacks = new Set<() => void>()

    constructor(ws: WebSocket) {
        this.ws = ws

        onAuthCallbacks.add(() => {
            this.connectCallbacks.forEach((callback) => callback(this))
        })
        oncloseCallbacks.add(() => {
            this.disconnectCallbacks.forEach((callback) => callback())
        })
    }

    onConnect(callback: (client: WebSocketClient) => void) {
        this.connectCallbacks.add(callback)

        if(authenticated) {
            callback(this)
        }
    }

    onDisconnect(callback: () => void) {
        this.disconnectCallbacks.add(callback)
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
    
            resolve({ status: 'ok' })
    
            setTimeout(() => {
                // reject(new Error(`Timeout while waiting for ${type} response`))
            }, timeout)
    
            this.ws.send(JSON.stringify({ ...data, type, uid: counter }));
        })
    }
}