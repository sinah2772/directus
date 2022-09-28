import { trimUpper } from './message';
import type { WebSocketMessage } from '../types';
import { InvalidPayloadException } from '../../exceptions';

export function parseIncomingMessage(data: string) {
	let message: WebSocketMessage;
	try {
		message = JSON.parse(data);
		message.type = trimUpper(message.type);
	} catch (err: any) {
		throw new InvalidPayloadException(err.message);
	}
	return message;
}
