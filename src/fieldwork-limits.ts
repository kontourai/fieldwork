/** Browser-safe limits shared by Fieldwork transports and storage. */
export const FIELDWORK_SOURCE_BYTES = 2 * 1024 * 1024;
export const REVIEWED_WEB_SOURCE_PAGE_CHARS = 16_384;
export const REVIEWED_WEB_SOURCE_MAX_PAGES = 8;
export const REVIEWED_WEB_SOURCE_MAX_TOTAL_PAGES = Math.ceil(FIELDWORK_SOURCE_BYTES / REVIEWED_WEB_SOURCE_PAGE_CHARS);
