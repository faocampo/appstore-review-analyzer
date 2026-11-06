/**
 * Keyset pagination for the review drill-down orders by (created_at, id)
 * within an app; this index serves it directly (top-N without a sort).
 */
export const name = "0004_review_keyset_index";

export const sql = `
create index review_app_created_id_idx on review (app_id, created_at desc, id desc);
drop index if exists review_app_created_idx;
`;
