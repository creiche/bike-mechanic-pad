export interface ReconciledForm<T> {
	form: T;
	// What the record holds now; the form's next comparison point.
	base: T;
	// Set when the mechanic and another device both changed a field. Their text stays in the form.
	conflict: string | null;
}

// Three-way merge of an open edit form. `base` is the record as the form last saw it, `fresh` is the record now.
// Untouched fields take the fresh value. `base` always moves to `fresh`, so a conflict warns once and the next save
// is a knowing overwrite.
export function reconcileForm<T extends Record<string, string>>(form: T, base: T, fresh: T): ReconciledForm<T> {
	const merged = { ...form };
	const conflicts: string[] = [];

	for (const key of Object.keys(fresh) as Array<keyof T & string>) {
		if (form[key] === base[key]) {
			merged[key] = fresh[key];
		} else if (fresh[key] !== base[key] && fresh[key] !== form[key]) {
			conflicts.push(`${key.replace(/_/g, ' ')} is now "${fresh[key]}"`);
		}
	}

	return {
		form: merged,
		base: { ...fresh },
		conflict: conflicts.length
			? `Another device changed this while you were editing: ${conflicts.join('; ')}. Your text is still in the form. Save again to replace that change.`
			: null
	};
}
