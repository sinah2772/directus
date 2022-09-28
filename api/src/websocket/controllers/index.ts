import type { Server as httpServer } from 'http';
import env from '../../env';
import { ServiceUnavailableException } from '../../exceptions';
import logger from '../../logger';
import { GraphQLSubscriptionController, WebsocketController } from '../controllers';

let websocketController: WebsocketController | undefined;

export function createWebsocketController(server: httpServer) {
	if (env['WEBSOCKETS_REST_ENABLED']) {
		websocketController = new WebsocketController(server);
		logger.info(`Websocket available at ws://${env['HOST']}:${env['PORT']}${websocketController.endpoint}`);
	}
}

export function getWebsocketController() {
	if (!env['WEBSOCKETS_ENABLED'] || !env['WEBSOCKETS_REST_ENABLED']) {
		throw new ServiceUnavailableException('Websocket server is disabled', {
			service: 'get-websocket-controller',
		});
	}
	if (!websocketController) {
		throw new ServiceUnavailableException('Websocket server is not initialized', {
			service: 'get-websocket-controller',
		});
	}
	return websocketController;
}

let subscriptionController: GraphQLSubscriptionController | undefined;

export function createSubscriptionController(server: httpServer) {
	if (env['WEBSOCKETS_GRAPHQL_ENABLED']) {
		subscriptionController = new GraphQLSubscriptionController(server);
		logger.info(`Subscriptions available at ws://${env['HOST']}:${env['PORT']}${subscriptionController.endpoint}`);
	}
}

export function getSubscriptionController() {
	return subscriptionController;
}

export * from './graphql';
export * from './rest';
