"use client";

import { Suspense } from "react";
import { AuthGuard } from "@/components/auth/auth-guard";
import { ComposeProvider } from "@/components/compose/compose-context";
import { useLanguage } from "@/components/language-provider";
import { LicenseIndicator } from "@/components/license-indicator";
import { MailSearchProvider } from "@/components/mail-search/mail-search-context";
import { MailboxProvider } from "@/components/mailbox-provider";
import { MailboxSelector } from "@/components/mailbox-selector";
import { RouteTitle } from "@/components/route-title";
import { ShortcutsProvider } from "@/components/shortcuts";
import { MobileMenuButton, SidebarAside } from "@/components/sidebar-aside";
import { SidebarHeader } from "@/components/sidebar-header";
import { SidebarResizeBoundary } from "@/components/sidebar-resize-boundary";
import { SidebarProvider, useSidebar } from "@/components/sidebar-state";
import { SkipToContent } from "@/components/skip-to-content";
import { TasksNav } from "./tasks-nav";

function TasksFrame({ children }: { children: React.ReactNode }) {
	const { t } = useLanguage();
	const { mobile, toggle } = useSidebar();
	// Same grid and sidebar width as Mail and Drive, so the menu lines up and resizing carries over.
	return (
		<div className="safe-area grid h-dvh grid-cols-[minmax(0,1fr)] overflow-hidden bg-[#f6f8fc] transition-[grid-template-columns] md:grid-cols-[var(--sidebar-width)_minmax(0,1fr)]" style={{ transitionDuration: "var(--sidebar-transition-duration)" }}>
			<SkipToContent />
			<SidebarAside>
				<div className="flex h-full min-h-0 flex-col">
					<div className="shrink-0 px-3 pt-4"><SidebarHeader href="/inbox" /></div>
					<Suspense fallback={null}><TasksNav onNavigate={mobile ? toggle : undefined} /></Suspense>
				</div>
				<SidebarResizeBoundary />
			</SidebarAside>
			<div className="flex min-h-0 min-w-0 flex-col">
				<header className="flex h-16 w-full shrink-0 items-center gap-3 pr-4 text-sm">
					<MobileMenuButton className="ml-2" />
					<p aria-hidden="true" className="min-w-0 flex-1 truncate text-lg font-medium text-neutral-800 md:invisible">{t("tasks.title")}</p>
					<LicenseIndicator />
					<MailboxSelector />
				</header>
				<main id="main-content" tabIndex={-1} className="min-h-0 min-w-0 flex-1 overflow-hidden focus:outline-none md:pr-4">{children}</main>
			</div>
		</div>
	);
}

export default function TasksLayout({ children }: { children: React.ReactNode }) {
	return (
		<AuthGuard>
			<SidebarProvider mobileOverlay>
				<MailboxProvider>
					<ComposeProvider>
						<MailSearchProvider>
							<ShortcutsProvider>
								<RouteTitle />
								<TasksFrame>{children}</TasksFrame>
							</ShortcutsProvider>
						</MailSearchProvider>
					</ComposeProvider>
				</MailboxProvider>
			</SidebarProvider>
		</AuthGuard>
	);
}
