"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bell,
  ChevronLeft,
  ChevronRight,
  FolderKanban,
  Home,
  LogOut,
  Menu,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";

interface Asset {
  id: string;
  canonical_name: string;
  asset_kind: string;
}

function navClass(active: boolean) {
  return [
    "flex h-9 items-center gap-3 rounded-md px-3 text-[13px] font-semibold transition-colors",
    active
      ? "bg-[#f3f6f8] text-black"
      : "text-gray-500 hover:bg-[#f7f8fa] hover:text-black",
  ].join(" ");
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const hideSidebar = pathname.includes("/run");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [queueCount, setQueueCount] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    async function loadShellData() {
      try {
        const [assetsRes, queueRes] = await Promise.all([
          fetch("/api/assets"),
          fetch("/api/review/queue"),
        ]);

        if (assetsRes.ok) {
          const data = await assetsRes.json();
          setAssets(Array.isArray(data) ? data.slice(0, 5) : []);
        }
        if (queueRes.ok) {
          const data = await queueRes.json();
          setQueueCount(Array.isArray(data) ? data.length : 0);
        }
      } catch (error) {
        console.error("Failed to load shell data:", error);
      }
    }

    loadShellData();
  }, []);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const activeAssetId = useMemo(() => {
    const match = pathname.match(/^\/assets\/([^/]+)/);
    return match?.[1] ?? null;
  }, [pathname]);

  if (hideSidebar) {
    return <main className="min-h-screen flex-1 overflow-auto bg-[#f4f7fa]">{children}</main>;
  }

  const sidebar = (
    <aside
      className={[
        "flex h-screen shrink-0 flex-col justify-between border-r border-[#e8edf2] bg-white/90 p-4 shadow-[8px_0_30px_rgba(17,24,39,0.03)] backdrop-blur-xl transition-all",
        collapsed ? "w-[76px]" : "w-[268px]",
      ].join(" ")}
    >
      <div className="min-w-0">
        <div className="mb-5 flex items-center justify-between">
          <Link href="/" className="flex min-w-0 items-center gap-2.5 text-black">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black text-[11px] font-bold text-white">
              K
            </div>
            {!collapsed && (
              <div className="min-w-0">
                <div className="truncate text-[15px] font-bold tracking-tight">Kintsugi OS</div>
                <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wider text-gray-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  Staging active
                </div>
              </div>
            )}
          </Link>
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            className="hidden h-8 w-8 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-50 hover:text-black lg:flex"
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-50 hover:text-black lg:hidden"
            title="Close navigation"
          >
            <X size={16} />
          </button>
        </div>

        {!collapsed && (
          <div className="mb-5 flex h-9 items-center gap-2 rounded-md border border-gray-200 bg-[#fbfcfd] px-3 text-[12px] text-gray-400">
            <Search size={14} />
            <span className="truncate">Search research vault</span>
          </div>
        )}

        <nav className="space-y-1">
          <Link href="/" className={navClass(pathname === "/")} title="Home">
            <Home size={16} />
            {!collapsed && <span>Home</span>}
          </Link>

          <Link href="/assets" className={navClass(pathname.startsWith("/assets"))} title="Projects">
            <FolderKanban size={16} />
            {!collapsed && <span>Projects</span>}
          </Link>

          {!collapsed && assets.length > 0 && (
            <div className="ml-[19px] mt-1 space-y-0.5 border-l border-gray-100 pl-3">
              {assets.map((asset) => {
                const isActive = activeAssetId === asset.id;
                return (
                  <Link
                    key={asset.id}
                    href={`/assets/${asset.id}/view`}
                    className={[
                      "block truncate rounded-sm px-2 py-1.5 text-[12px] transition-colors",
                      isActive
                        ? "bg-[#f3f6f8] font-semibold text-black"
                        : "text-gray-500 hover:bg-gray-50 hover:text-black",
                    ].join(" ")}
                  >
                    {asset.canonical_name}
                  </Link>
                );
              })}
            </div>
          )}

          <Link href="/review" className={navClass(pathname.startsWith("/review"))} title="Review Queue">
            <ShieldCheck size={16} />
            {!collapsed && (
              <>
                <span className="flex-1">Review Queue</span>
                {queueCount > 0 && (
                  <span className="rounded-full bg-black px-1.5 py-0.5 font-mono text-[9px] text-white">
                    {queueCount}
                  </span>
                )}
              </>
            )}
          </Link>
        </nav>
      </div>

      <div className="space-y-3 border-t border-[#eef2f6] pt-4">
        {!collapsed && (
          <div className="rounded-md border border-gray-200 bg-[#fbfcfd] p-3">
            <div className="flex items-center gap-2 text-[12px] font-bold text-black">
              <Sparkles size={14} />
              Research Runtime
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[10px] text-gray-500">
              <div>
                <div className="text-gray-400">Assets</div>
                <div className="font-bold text-black">{assets.length}</div>
              </div>
              <div>
                <div className="text-gray-400">Gates</div>
                <div className="font-bold text-black">{queueCount}</div>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-1 text-[13px] font-semibold text-gray-500">
          <Link href="/" className="flex h-8 items-center gap-3 rounded-md px-3 transition-colors hover:bg-gray-50 hover:text-black" title="Settings">
            <Settings size={15} />
            {!collapsed && <span>Settings</span>}
          </Link>
          <div className="flex h-8 items-center gap-3 rounded-md px-3 transition-colors hover:bg-gray-50 hover:text-black" title="Notifications">
            <Bell size={15} />
            {!collapsed && <span className="flex-1">Notifications</span>}
            {!collapsed && queueCount > 0 && (
              <span className="rounded-full bg-rose-500 px-1.5 py-0.5 font-mono text-[9px] text-white">
                {queueCount}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-[#eef2f6] pt-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-gray-200 bg-gray-100 text-[11px] font-bold text-gray-600">
              SL
            </div>
            {!collapsed && (
              <div className="min-w-0 leading-tight">
                <div className="truncate text-[12px] font-semibold text-black">Sophia Lane</div>
                <div className="truncate text-[10px] text-gray-400">Investment research</div>
              </div>
            )}
          </div>
          {!collapsed && (
            <button
              type="button"
              onClick={() => router.push("/")}
              className="flex h-8 w-8 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-50 hover:text-black"
              title="Sign out"
            >
              <LogOut size={15} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );

  return (
    <div className="min-h-screen bg-[#f4f7fa] text-[#111111]">
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        className="fixed left-4 top-4 z-40 flex h-10 w-10 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-600 shadow-sm lg:hidden"
        title="Open navigation"
      >
        <Menu size={18} />
      </button>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/20"
            onClick={() => setMobileOpen(false)}
            title="Close navigation backdrop"
          />
          <div className="relative">{sidebar}</div>
        </div>
      )}

      <div className="flex min-h-screen">
        <div className="hidden lg:block">{sidebar}</div>
        <main className="min-w-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
