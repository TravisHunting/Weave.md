// Saving in Weave stamps OKF created_at and updated_at, adding `type: Note` to an
// article without frontmatter. Verification compares the authored content.
export const STAMP = /(?:created_at|updated_at): \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d\r?\n/g;
/** The text without Weave's timestamps (and without a frontmatter block they alone required). */
export const unstamped = text => text.replace(STAMP, '').replace(/^---\r?\ntype: Note\r?\n---\r?\n/, '');
/** Whether the text carries both timestamps. */
export const stamped = text => (text.match(STAMP) || []).length === 2;
