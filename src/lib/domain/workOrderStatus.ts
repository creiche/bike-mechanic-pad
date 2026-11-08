import type { WorkOrderStatus } from '../db/repositories/workOrders';

export const STATUS_LABELS: Record<WorkOrderStatus, string> = {
	open: 'Open',
	in_progress: 'In progress',
	ready_for_pickup: 'Ready for pickup',
	completed: 'Completed',
	cancelled: 'Cancelled'
};

// Full class strings so Tailwind can see them. Colours stay distinguishable at a glance under shop lighting.
export const STATUS_BADGE_CLASSES: Record<WorkOrderStatus, string> = {
	open: 'border-sky-600 bg-sky-950/60 text-sky-200',
	in_progress: 'border-amber-500 bg-amber-950/60 text-amber-200',
	ready_for_pickup: 'border-emerald-500 bg-emerald-950/60 text-emerald-200',
	completed: 'border-neutral-600 bg-neutral-800 text-neutral-300',
	cancelled: 'border-rose-700 bg-rose-950/50 text-rose-200'
};

export const ACTIVE_STATUSES: readonly WorkOrderStatus[] = ['open', 'in_progress', 'ready_for_pickup'];
