/**
 * Types for websocket controllers
 */
import type { Accountability, Query } from '@directus/shared/types';
import type { WebSocket } from 'ws';

export type SocketControllerConfig = {
	endpoint: string; // endpoint for request upgrade
	auth:
		| {
				mode: 'public' | 'strict';
		  }
		| {
				mode: 'handshake';
				timeout: number;
		  };
};

export type WebsocketClient = WebSocket & { accountability: Accountability };

export type Subscription = {
	uid?: string;
	query?: Query;
	client: WebsocketClient;
};
export type SubscriptionMap = Record<string, Set<Subscription>>;
