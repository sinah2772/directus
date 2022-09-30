import { trimUpper } from './message';
import type { WebSocketMessage } from '../types';
import { WebSocketException } from '../exceptions';

export function parseIncomingMessage(data: string) {
	let message: WebSocketMessage;
	try {
		message = JSON.parse(data);
		message.type = trimUpper(message.type);
	} catch (err: any) {
		throw new WebSocketException('parser', 'INVALID_PAYLOAD', 'Unable to parse the incoming message!');
	}
	return message;
}
