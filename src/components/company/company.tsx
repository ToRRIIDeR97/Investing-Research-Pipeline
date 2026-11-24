"use client";
// Company identity on every page: the logo (or a monogram), the asset hero and the leadership with photos.
// Images come only from Wikimedia hosts (checked on the server) and load without a referrer.
import { useState, type ReactNode } from "react";
import { SLOW_LOOKUP_NOTE, useCompanyProfile, type CompanyPerson, type ProfileSubject } from "./use-company-profiles";
import styles from "./company.module.css";
import { logoBox } from "./logo-box";
import ui from "@/components/research-ui.module.css";

const initials = (name: string) => name.replace(/\(.*?\)/g, "").replace(/,?\s+(inc|corp|ltd|plc|llc)\.?$/i, "").split(/\s+/).filter(Boolean)
  .slice(0, 2).map((word) => word[0]).join("").toUpperCase() || "?";

/** A company's logo, normalized to a common visual size; a ticker or initials monogram when there is none (or it fails to load). */
export function CompanyLogo({ subject, name, ticker, size = 40, shape = "square" }: { subject: ProfileSubject | null; name: string; ticker?: string | null; size?: number; shape?: "square" | "round" }) {
  const { profile, loading, throttled } = useCompanyProfile(subject);
  const [broken, setBroken] = useState<string | null>(null);
  const [ratio, setRatio] = useState<{ src: string; r: number } | null>(null);
  const src = profile?.logo_url && broken !== profile.logo_url ? profile.logo_url : null;
  const mono = ticker && ticker.length <= 4 ? ticker.toUpperCase() : initials(name);
  if (src) {
    const box = logoBox(size, ratio?.src === src ? ratio.r : 1);
    return <span className={styles.logo} data-shape={shape} style={{ width: size, height: size }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- remote Wikimedia logo, sized by its shape */}
      <img src={src} alt={`${name} logo`} referrerPolicy="no-referrer" loading="lazy" style={box}
        onLoad={(e) => { const i = e.currentTarget; if (i.naturalWidth && i.naturalHeight) setRatio({ src, r: i.naturalWidth / i.naturalHeight }); }}
        onError={() => setBroken(src)} />
    </span>;
  }
  return <span className={`${styles.logo} ${styles.monogram}`} data-shape={shape} data-loading={loading} aria-hidden="true"
    title={loading && throttled ? SLOW_LOOKUP_NOTE : undefined}
    style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * (mono.length > 2 ? 0.26 : 0.36))) }}>{mono}</span>;
}

function Avatar({ person, small }: { person: CompanyPerson; small?: boolean }) {
  const [broken, setBroken] = useState(false);
  return <span className={styles.avatar} aria-hidden={!person.photo_url || broken ? "true" : undefined}>
    {person.photo_url && !broken
      // eslint-disable-next-line @next/next/no-img-element -- remote Wikimedia photo
      ? <img src={person.photo_url} alt={small ? "" : `${person.name}`} referrerPolicy="no-referrer" loading="lazy" onError={() => setBroken(true)} />
      : initials(person.name)}
  </span>;
}

/** Founders and executives with their photos, from the company's Wikipedia infobox (or Wikidata). */
export function Leadership({ subject, title = "Leadership", compact = false, className }: { subject: ProfileSubject | null; title?: string; compact?: boolean; className?: string }) {
  const { profile, loading, throttled } = useCompanyProfile(subject);
  const people = profile?.people ?? [];
  if (compact) return people.length ? <div className={styles.peopleRow} aria-label={title}>
    {people.slice(0, 4).map((person) => <span key={person.name} className={styles.miniPerson}><Avatar person={person} small /><span><strong>{person.name}</strong><em>{person.role}</em></span></span>)}
  </div> : null;
  return <section className={`${ui.tile} ${className ?? ""}`} aria-labelledby="leadership-title">
    <div className={ui.tileHead}>
      <h2 id="leadership-title">{title}</h2>
      {profile?.website && <a className={ui.textLink} href={profile.website} target="_blank" rel="noopener noreferrer">Company website</a>}
    </div>
    {loading && !people.length ? <>
        <div className={styles.skeleton} role="status" aria-label="Looking up leadership" />
        {throttled && <p className={styles.credit}>{SLOW_LOOKUP_NOTE}</p>}
      </>
      : people.length ? <>
        <div className={styles.people}>{people.map((person) => <div key={person.name} className={styles.person}>
          <Avatar person={person} />
          <div className={styles.personName}>{person.page_url ? <a href={person.page_url} target="_blank" rel="noopener noreferrer">{person.name}</a> : person.name}</div>
          <span className={styles.personRole}>{person.role}</span>
        </div>)}</div>
        <p className={styles.credit}>Names and photos from {profile?.wikipedia_url ? <a href={profile.wikipedia_url} target="_blank" rel="noopener noreferrer">Wikipedia</a> : "Wikipedia"} and Wikimedia Commons; display only, not research evidence.</p>
      </> : <p className={ui.empty}>No leadership listed on Wikipedia for this company.</p>}
  </section>;
}

/** The page header for an asset: logo, name, ticker, kind and sector, a status chip and the page's actions. */
export function AssetHero({ assetId, name, ticker, meta, status, actions, eyebrow }: {
  assetId: string; name: string; ticker?: string | null; meta?: (string | null | undefined)[]; status?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode;
}) {
  const details = (meta ?? []).filter((item): item is string => !!item);
  return <header className={styles.hero}>
    <div className={styles.heroMain}>
      <CompanyLogo subject={{ asset_id: assetId }} name={name} ticker={ticker} size={60} />
      <div className={styles.heroText}>
        {eyebrow}
        <h1>{name}</h1>
        <div className={styles.heroMeta}>
          {ticker && <span className={styles.ticker}>{ticker}</span>}
          {details.map((item, index) => <span key={item} className="contents">{(index > 0 || ticker) && <span className={styles.dot} aria-hidden="true">·</span>}<span>{item}</span></span>)}
          {status}
        </div>
      </div>
    </div>
    {actions && <div className={styles.heroActions}>{actions}</div>}
  </header>;
}
