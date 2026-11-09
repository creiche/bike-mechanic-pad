// Shared Tailwind class strings. Every control is at least 48px tall so it is easy to hit with a gloved or greasy finger.
export const inputClass =
	'min-h-12 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-base text-neutral-100 outline-none transition focus:border-amber-500';

export const labelTextClass = 'mb-1.5 block text-sm text-neutral-300';

const buttonBase =
	'inline-flex min-h-12 items-center justify-center rounded-md px-5 py-2 text-base font-semibold transition disabled:cursor-not-allowed disabled:opacity-50';

export const primaryButton = `${buttonBase} bg-amber-500 text-neutral-950 hover:bg-amber-400`;
export const successButton = `${buttonBase} bg-emerald-500 text-neutral-950 hover:bg-emerald-400`;
export const secondaryButton = `${buttonBase} border border-neutral-600 bg-neutral-900 text-neutral-100 hover:bg-neutral-800`;
export const dangerButton = `${buttonBase} border border-rose-700 bg-rose-950/30 text-rose-200 hover:bg-rose-900/40`;

export const cardClass = 'rounded-xl border border-neutral-800 bg-neutral-900 p-5 shadow-lg shadow-black/20';
export const errorBannerClass = 'rounded-md border border-rose-800 bg-rose-950/30 px-4 py-3 text-sm text-rose-200';
