import { logout, LogoutReason, refresh } from '@/auth';
import { useRequestsStore } from '@/stores/requests';
import { getPublicURL, getRootPath } from '@/utils/get-root-path';
import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';
import { addQueryToPath } from './utils/add-query-to-path';
import PQueue, { Options, DefaultAddOptions } from 'p-queue';
import { Query } from '@directus/shared/types';
import api from './api';
import cards from './layouts/cards';

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

class AuthHandler {
    ws: WebSocket
    authenticated = false;
    authCallbacks: ((authenticated: boolean) => void)[] = [];

    constructor(ws: WebSocket) {
        this.ws = ws;

        ws.onopen = () => {
            setTimeout(() => {
                this.authenticate()
            }, 1)
        }
        
        ws.onclose = () => {
            this.authenticated = false;
            console.log("Connection closed")
        }
    }

    async authenticate() {
        let token = api.defaults.headers.common['Authorization'].substring(7)
    
        console.log("Authenticating with token", token)
    
        try {
            this.authenticated = true;

            const response = await send('HANDSHAKE', {access_token: token})
            console.log("Authenticated", response)
    
            if(response['status'] === 'ok') {
                this.authCallbacks.forEach((callback) => callback(true))
                this.authCallbacks = []
            }
    
            if(response['status'] === 'error' && false) {
                console.error("Authentication failed", response['error'])
                this.authenticated = false;
                this.authCallbacks.forEach((callback) => callback(false))
                this.authCallbacks = []
            }
        } catch(error) {
            console.error(error)
            this.authenticated = false
            this.authCallbacks.forEach((callback) => callback(false))
            this.authCallbacks = []
        }
    }

    async isAuthenticated() {
        if(this.authenticated) return true;

        return new Promise<boolean>((resolve) => {
            this.authCallbacks.push(resolve)
        })
    }
}

const ws = new WebSocket("ws://localhost:8055/websocket");
const callbacks = new Map<number, MessageCallback>()
const authHandler = new AuthHandler(ws)

ws.onmessage = (event) => {
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
        const callback = callbacks.get(uid)
        if(callback) callback(message)
    }
}

export function subscribe(options: SubscribeOptions, callback: MessageCallback) {
    const counter = uidCounter.next().value;

    authHandler.isAuthenticated().then((authenticated) => {
        if(!authenticated) return;

        callbacks.set(counter, callback)
        const data: Record<string, any> = { 
            type: 'SUBSCRIBE',
            collection: options.collection,
            uid: counter
        }

        if(options.item) data['item'] = options.item;
        if(options.query) data['query'] = options.query;

        ws.send(JSON.stringify(data));
    })

    return counter;
}

export function unsubscribe(uid: number) {
    callbacks.delete(uid);
    authHandler.isAuthenticated().then((authenticated) => {
        if(!authenticated) return;

        ws.send(JSON.stringify({ type: 'UNSUBSCRIBE', uid }));
    })
}

export function send(type: MessageType, data: Record<string, any> = {}, timeout: number = 5000) {
    const counter = uidCounter.next().value;

    return new Promise<Record<string, any>>(async (resolve, reject) => {
        const authenticated = await authHandler.isAuthenticated();

        if(!authenticated) return {}

        callbacks.set(counter, (data) => {
            callbacks.delete(counter);
            resolve(data)
        })

        resolve({ status: 'ok' })

        setTimeout(() => {
            // reject(new Error(`Timeout while waiting for ${type} response`))
        }, timeout)

        ws.send(JSON.stringify({ ...data, type, uid: counter }));
    })
}

export default ws;