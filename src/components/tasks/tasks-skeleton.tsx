import { Skeleton } from "@/components/ui/skeleton";

/** Placeholder for /tasks while the session resolves: the menu rail, then a panel of task rows. */
export function TasksSkeleton() {
	return (
		<div className="safe-area flex h-dvh flex-col bg-[#f6f8fc]">
			<div className="flex h-16 items-center gap-3 px-4">
				<Skeleton className="h-10 w-10 shrink-0 rounded-full" />
				<Skeleton className="h-6 w-28" />
				<div className="flex-1" />
				<Skeleton className="h-9 w-9 rounded-full" />
			</div>
			<div className="flex min-h-0 flex-1 gap-3 pl-3 max-md:pl-0 md:pr-4">
				<div className="hidden w-60 shrink-0 space-y-2 md:block">
					<Skeleton className="mb-4 h-14 w-32 rounded-2xl" />
					{Array.from({ length: 6 }, (_, row) => <Skeleton key={row} className="h-10 w-full rounded-full" />)}
				</div>
				<div className="min-w-0 flex-1 overflow-hidden rounded-t-3xl bg-white">
					<div className="flex h-[4.25rem] items-center border-b border-neutral-200 px-5"><Skeleton className="h-7 w-40" /></div>
					<div className="space-y-1 px-3 pt-3">
						{Array.from({ length: 7 }, (_, row) => (
							<div key={row} className="flex h-9 items-center gap-3 pl-8">
								<Skeleton className="h-[18px] w-[18px] shrink-0 rounded-full" />
								<Skeleton className="h-3.5" style={{ width: `${46 - (row % 4) * 8}%` }} />
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}
