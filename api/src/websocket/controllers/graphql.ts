import type { Server as httpServer } from 'http';
import logger from '../../logger';
import { getAccountabilityForToken } from '../../utils/get-accountability-for-token';
import { useServer as useGraphQLServer } from 'graphql-ws/lib/use/ws';
import { getSchema } from '../../utils/get-schema';
import { GraphQLService } from '../../services';
import env from '../../env';
import SocketController from './base';

export class GraphQLSubscriptionController extends SocketController {
	constructor(httpServer: httpServer) {
		super(httpServer, 'WS GraphQL', env['WEBSOCKETS_GRAPHQL_PATH'], {
			mode: env['WEBSOCKETS_GRAPHQL_AUTH'],
			timeout: env['WEBSOCKETS_GRAPHQL_AUTH_TIMEOUT'] * 1000,
		});
		// hook ws server into graphql logic
		useGraphQLServer(
			{
				context: {},
				schema: async (ctx) => {
					const accountability = await getAccountabilityForToken(
						ctx.connectionParams?.['access_token'] as string | undefined
					);

					const service = new GraphQLService({
						schema: await getSchema(),
						scope: 'items',
						accountability,
					});

					return service.getSchema();
				},
			},
			this.server
		);
		// add some basic debug logs
		this.server.on('connection', (ws) => {
			logger.debug(`[WSS GraphQL] Connected`);
			ws.on('message', (data) => {
				logger.debug(`[WSS GraphQL] Received: ${data}`);
			});
		});
	}
}
