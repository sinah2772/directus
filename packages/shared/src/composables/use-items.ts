import { useApi } from './use-system.js';
import axios, { CancelTokenSource } from 'axios';
import { useCollection } from './use-collection.js';
import type { Item, Query } from '../types/index.js';
import { moveInArray } from '../utils/index.js';
import { isEqual, throttle } from 'lodash-es';
import { computed, ComputedRef, ref, Ref, watch, WritableComputedRef, unref, onUnmounted } from 'vue';
import { getWebSocket } from './use-system.js';

type ManualSortData = {
	item: string | number;
	to: string | number;
};

type UsableItems = {
	itemCount: Ref<number | null>;
	totalCount: Ref<number | null>;
	items: Ref<Item[]>;
	totalPages: ComputedRef<number>;
	loading: Ref<boolean>;
	error: Ref<any>;
	changeManualSort: (data: ManualSortData) => Promise<void>;
	getItems: () => Promise<void>;
};

type ComputedQuery = {
	fields: Ref<Query['fields']> | ComputedRef<Query['fields']> | WritableComputedRef<Query['fields']>;
	alias?: Ref<Query['alias']> | ComputedRef<Query['alias']> | WritableComputedRef<Query['alias']>;
	limit: Ref<Query['limit']> | ComputedRef<Query['limit']> | WritableComputedRef<Query['limit']>;
	sort: Ref<Query['sort']> | ComputedRef<Query['sort']> | WritableComputedRef<Query['sort']>;
	search: Ref<Query['search']> | ComputedRef<Query['search']> | WritableComputedRef<Query['search']>;
	filter: Ref<Query['filter']> | ComputedRef<Query['filter']> | WritableComputedRef<Query['filter']>;
	page: Ref<Query['page']> | WritableComputedRef<Query['page']>;
};

export function useItems(collection: Ref<string | null>, query: ComputedQuery, fetchOnInit = true): UsableItems {
	const api = useApi();
	const { primaryKeyField } = useCollection(collection);

	const { fields, alias, limit, sort, search, filter, page } = query;

	const endpoint = computed(() => {
		if (!collection.value) return null;
		return collection.value.startsWith('directus_')
			? `/${collection.value.substring(9)}`
			: `/items/${collection.value}`;
	});

	const items = ref<Item[]>([]);
	const loading = ref(false);
	const error = ref<any>(null);

	const itemCount = ref<number | null>(null);
	const totalCount = ref<number | null>(null);

	const totalPages = computed(() => {
		if (itemCount.value === null) return 1;
		if (itemCount.value < (unref(limit) ?? 100)) return 1;
		return Math.ceil(itemCount.value / (unref(limit) ?? 100));
	});

	let currentRequest: CancelTokenSource | null = null;
	let loadingTimeout: NodeJS.Timeout | null = null;
	let webSocketsActive = false;

	const finalQuery = computed(() => {
		let fieldsToFetch = [...(unref(fields) ?? [])];

		// Make sure the primary key is always fetched
		if (
			!unref(fields)?.includes('*') &&
			primaryKeyField.value &&
			fieldsToFetch.includes(primaryKeyField.value.field) === false
		) {
			fieldsToFetch.push(primaryKeyField.value.field);
		}

		// Filter out fake internal columns. This is (among other things) for a fake $thumbnail m2o field
		// on directus_files
		fieldsToFetch = fieldsToFetch.filter((field) => field.startsWith('$') === false);

		return {
			limit: unref(limit) ?? null,
			fields: fieldsToFetch ?? null,
			...(alias ? { alias: unref(alias) ?? null } : {}),
			sort: unref(sort) ?? null,
			page: unref(page) ?? null,
			search: unref(search) ?? null,
			filter: unref(filter) ?? null,
			meta: ['filter_count', 'total_count'],
		};
	});

	const fetchItems = throttle(getItems, 500);

	if (fetchOnInit) {
		fetchItems();
	}

	watch(
		[collection, limit, sort, search, filter, fields, page],
		async (after, before) => {
			if (isEqual(after, before)) return;

			const [newCollection, newLimit, newSort, newSearch, newFilter, _newFields, _newPage] = after;
			const [oldCollection, oldLimit, oldSort, oldSearch, oldFilter, _oldFields, _oldPage] = before;

			if (!newCollection || !query) return;

			if (
				!isEqual(newFilter, oldFilter) ||
				!isEqual(newSort, oldSort) ||
				newLimit !== oldLimit ||
				newSearch !== oldSearch
			) {
				if (oldCollection) {
					page.value = 1;
				}
			}

			if (newCollection !== oldCollection) {
				reset();
			}

			fetchItems();
		},
		{ deep: true, immediate: true }
	);

	const ws = getWebSocket();

	let subscriptionId: number | null = null;

	ws.onConnect((client) => {
		watch(
			[collection, finalQuery],
			([newCollection, newQuery]) => {
				if (subscriptionId !== null) client.unsubscribe(subscriptionId);

				subscriptionId = client.subscribe(
					{
						collection: newCollection!,
						query: newQuery,
					},
					(data) => {
						onItemChange({ data: data['payload'], meta: data['meta'] });
					}
				);
			},
			{ immediate: true }
		);

		webSocketsActive = true;

		onUnmounted(() => {
			if (subscriptionId !== null) client.unsubscribe(subscriptionId);
		});
	});

	ws.onDisconnect(() => {
		webSocketsActive = false;
	});

	return { itemCount, totalCount, items, totalPages, loading, error, changeManualSort, getItems };

	async function getItems() {
		if (!endpoint.value || webSocketsActive) return;

		currentRequest?.cancel();
		currentRequest = null;

		error.value = null;

		if (loadingTimeout) {
			clearTimeout(loadingTimeout);
		}

		loadingTimeout = setTimeout(() => {
			loading.value = true;
		}, 150);

		try {
			currentRequest = axios.CancelToken.source();

			const response = await api.get<any>(endpoint.value, {
				params: finalQuery.value,
				cancelToken: currentRequest.token,
			});

			onItemChange(response.data);
		} catch (err: any) {
			if (!axios.isCancel(err)) {
				error.value = err;
			}
		} finally {
			if (loadingTimeout) {
				clearTimeout(loadingTimeout);
				loadingTimeout = null;
			}

			loading.value = false;
		}
	}

	function onItemChange(data: { data: Record<string, any>[]; meta: Record<string, any> }) {
		// console.log('onItemChange', data);
		if (!data.data) return;
		let fetchedItems = data.data;
		/**
		 * @NOTE
		 *
		 * This is used in conjunction with the fake field in /src/stores/fields/fields.ts to be
		 * able to render out the directus_files collection (file library) using regular layouts
		 *
		 * Layouts expect the file to be a m2o of a `file` type, however, directus_files is the
		 * only collection that doesn't have this (obviously). This fake $thumbnail field is used to
		 * pretend there is a file m2o, so we can use the regular layout logic for files as well
		 */
		if (collection.value === 'directus_files') {
			fetchedItems = fetchedItems['map']((file: any) => ({
				...file,
				$thumbnail: file,
			}));
		}

		items.value = fetchedItems;
		totalCount.value = data.meta?.['total_count'] ?? null;
		itemCount.value = data.meta?.['filter_count'] ?? null;

		if (page && fetchedItems['length'] === 0 && page?.value !== 1) {
			page.value = 1;
		}
	}

	function reset() {
		items.value = [];
		totalCount.value = null;
		itemCount.value = null;
	}

	async function changeManualSort({ item, to }: ManualSortData) {
		const pk = primaryKeyField.value?.field;
		if (!pk) return;

		const fromIndex = items.value.findIndex((existing: Record<string, any>) => existing[pk] === item);
		const toIndex = items.value.findIndex((existing: Record<string, any>) => existing[pk] === to);

		items.value = moveInArray(items.value, fromIndex, toIndex);

		const endpoint = computed(() => `/utils/sort/${collection.value}`);
		await api.post(endpoint.value, { item, to });
	}
}
