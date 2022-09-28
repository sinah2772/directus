import { createClient } from 'graphql-ws';
import { loadHistory, sendMessage, subscribeToChat } from './api';

const client = createClient({
	url: 'ws://localhost:8055/graphql',
	keepAlive: 30000,
	connectionParams: () => {
		return { access_token: 'admin' };
	},
});

const $status = document.getElementById('status')!;
client.on('connected', async () => {
	$status.innerText = 'connected';
	await loadHistory();
	document.querySelector('button[type="submit"]')?.removeAttribute('disabled');
});
client.on('connecting', () => {
	$status.innerText = 'connecting';
});
client.on('error', () => {
	$status.innerText = 'error';
	document.querySelector('button[type="submit"]')?.setAttribute('disabled', '');
});
client.on('closed', () => {
	$status.innerText = 'closed';
	document.querySelector('button[type="submit"]')?.setAttribute('disabled', '');
});
subscribeToChat(client);

document.querySelector('#send')?.addEventListener('submit', async (event) => {
	event.preventDefault();

	const message = document.querySelector('textarea[name="message"]');
	await sendMessage((message as HTMLTextAreaElement).value);
});
