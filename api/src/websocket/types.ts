import type { Accountability, Query } from '@directus/shared/types';
import type { WebSocket } from 'ws';
import type { IncomingMessage } from 'http';

export type SocketControllerConfig = {
	endpoint: string; // endpoint for request upgrade
	auth: {
		mode: 'public' | 'handshake' | 'strict';
		timeout: number;
	};
};

export type WebsocketClient = WebSocket & {
	accountability: TemporaryAccountability | null;
};

export type Subscription = {
	uid?: string;
	query?: Query;
	client: WebsocketClient;
};
export type SubscriptionMap = Record<string, Set<Subscription>>;

export type TemporaryAccountability = Accountability & { expiresAt?: number | null };

export type WebRequest = IncomingMessage & {
	accountability: TemporaryAccountability | null;
};

export type WebsocketMessage = { type: string } & Record<string, any>;

export type ResponseMessage =
	| {
			type: string;
			status: 'ok';
	  }
	| {
			type: string;
			status: 'error';
			error: {
				code: string;
				message: string;
			};
	  };

export type SubscribeMessage = {
	type: 'SUBSCRIBE';
	collection: string;
	item?: string | number;
	query?: Query & {
		status: boolean;
		event: string | string[];
	};
};

export type AuthMessage =
	| { type: 'AUTH'; email: string; password: string }
	| { type: 'AUTH'; access_token: string }
	| { type: 'AUTH'; refresh_token: string };
