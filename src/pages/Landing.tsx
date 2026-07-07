import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ThemeToggle } from '../components/ThemeToggle';
import {
  BankIcon,
  CalendarIcon,
  ChartIcon,
  CoinsIcon,
  ShieldIcon,
  TargetIcon,
  WalletIcon,
} from '../components/Icons';

// Decorative mini-chart bars for the bento showcase cell.
const BENTO_BARS = [38, 60, 45, 72, 52, 80, 48, 66, 58, 90];

export function Landing({ authed }: { authed: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const motionOK = useRef(true);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    motionOK.current = !reduce;

    // Scroll reveals (fade-up on enter). Reduced motion → reveal immediately.
    const revealEls = Array.from(root.querySelectorAll<HTMLElement>('.reveal'));
    let io: IntersectionObserver | undefined;
    if (reduce || !('IntersectionObserver' in window)) {
      revealEls.forEach((el) => el.classList.add('reveal-in'));
    } else {
      io = new IntersectionObserver(
        (entries, obs) => {
          entries.forEach((e) => {
            if (e.isIntersecting) {
              e.target.classList.add('reveal-in');
              obs.unobserve(e.target);
            }
          });
        },
        { threshold: 0.12, rootMargin: '0px 0px -6% 0px' }
      );
      revealEls.forEach((el) => io!.observe(el));
    }

    // Nav condense + scroll parallax on decorative layers (transform only).
    const nav = root.querySelector<HTMLElement>('.landing-nav');
    const parallaxEls = Array.from(root.querySelectorAll<HTMLElement>('[data-parallax]'));
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const y = window.scrollY;
        if (nav) nav.classList.toggle('scrolled', y > 8);
        if (!reduce) {
          for (const el of parallaxEls) {
            const sp = parseFloat(el.dataset.parallax || '0');
            el.style.transform = `translate3d(0, ${(y * sp).toFixed(1)}px, 0)`;
          }
        }
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    // Subtle 3D tilt on the preview (desktop pointer only).
    let untilt = () => {};
    if (!reduce && fine) {
      const hero = root.querySelector<HTMLElement>('.landing-hero');
      const card = root.querySelector<HTMLElement>('.lp-window');
      if (hero && card) {
        const onMove = (e: MouseEvent) => {
          const r = hero.getBoundingClientRect();
          const dx = (e.clientX - r.left) / r.width - 0.5;
          const dy = (e.clientY - r.top) / r.height - 0.5;
          card.style.transform = `rotateY(${(dx * 7).toFixed(2)}deg) rotateX(${(-dy * 7).toFixed(2)}deg)`;
        };
        const onLeave = () => {
          card.style.transform = '';
        };
        hero.addEventListener('mousemove', onMove);
        hero.addEventListener('mouseleave', onLeave);
        untilt = () => {
          hero.removeEventListener('mousemove', onMove);
          hero.removeEventListener('mouseleave', onLeave);
        };
      }
    }

    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
      io?.disconnect();
      untilt();
    };
  }, []);

  const primary = authed ? (
    <Link className="btn btn-primary btn-lg btn-glow" to="/dashboard">
      Open your dashboard
    </Link>
  ) : (
    <Link className="btn btn-primary btn-lg btn-glow" to="/register">
      Create your free account
    </Link>
  );

  return (
    <div className="landing" ref={rootRef}>
      <header className="landing-nav">
        <div className="landing-nav-inner">
          <span className="landing-brand">
            <span className="logo-badge">
              <WalletIcon size={17} />
            </span>
            SpendTracker
          </span>
          <div className="landing-nav-actions">
            <ThemeToggle className="btn-icon" />
            {authed ? (
              <Link className="btn btn-primary" to="/dashboard">
                Go to dashboard
              </Link>
            ) : (
              <>
                <Link className="btn landing-hide-sm" to="/login">
                  Sign in
                </Link>
                <Link className="btn btn-primary" to="/register">
                  Get started
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      <main>
        <section className="landing-hero">
          {/* Decorative parallax aurora — behind everything, aria-hidden. */}
          <div className="landing-aurora" aria-hidden="true">
            <span className="blob blob-a" data-parallax="0.18" />
            <span className="blob blob-b" data-parallax="-0.12" />
            <span className="blob blob-c" data-parallax="0.08" />
            <span className="landing-grid" data-parallax="0.04" />
          </div>

          <div className="landing-hero-inner">
            <div className="landing-hero-copy">
            <span className="landing-badge reveal">Free while in beta</span>
            <h1 className="landing-h1 reveal">
              Know exactly where <span className="landing-grad">your money goes.</span>
            </h1>
            <p className="landing-lead reveal">
              SpendTracker brings your accounts, budgets, and income together — so you can see your
              whole financial picture in one clean, private place.
            </p>
            <div className="landing-cta-row reveal">
              {primary}
              {!authed && (
                <Link className="btn btn-lg" to="/login">
                  I already have an account
                </Link>
              )}
            </div>
            <p className="landing-hero-note reveal">No credit card needed · Works on any device</p>
          </div>

            <div className="landing-hero-visual" data-parallax="-0.05" aria-hidden="true">
              <DashboardPreview motionOK={motionOK} />
            </div>
          </div>
        </section>

        <section className="landing-features">
          <div className="landing-section-head reveal">
            <h2>Everything you need to stay on top of your money</h2>
            <p>Simple enough for daily use, detailed enough to actually change your habits.</p>
          </div>
          <div className="bento">
            <div className="landing-feature bento-cell bento-a reveal">
              <span className="landing-feature-icon">
                <ChartIcon size={22} />
              </span>
              <h3>See your whole money picture</h3>
              <p>
                Income vs. expenses, spending by category, and 6-month trends — the full story at a
                glance, no spreadsheet required.
              </p>
              <div className="bento-chart" aria-hidden="true">
                {BENTO_BARS.map((h, i) => (
                  <span
                    key={i}
                    style={{
                      height: `${h}%`,
                      background: i % 3 === 0 ? 'var(--red)' : 'var(--green)',
                    }}
                  />
                ))}
              </div>
            </div>
            <div className="landing-feature bento-cell bento-b reveal" style={{ transitionDelay: '60ms' }}>
              <span className="landing-feature-icon">
                <BankIcon size={22} />
              </span>
              <h3>All your accounts</h3>
              <p>Debit, credit, and loans with live balances that update as you spend, transfer, and pay.</p>
            </div>
            <div className="landing-feature bento-cell bento-c reveal" style={{ transitionDelay: '120ms' }}>
              <span className="landing-feature-icon">
                <TargetIcon size={22} />
              </span>
              <h3>Budgets that fit you</h3>
              <p>Weekly, monthly, or yearly limits per category — always know what’s left.</p>
            </div>
            <div className="landing-feature bento-cell bento-d reveal" style={{ transitionDelay: '80ms' }}>
              <span className="landing-feature-icon">
                <CalendarIcon size={22} />
              </span>
              <h3>Any time range</h3>
              <p>Day, week, month, or year — or jump to any date with the calendar.</p>
            </div>
            <div className="landing-feature bento-cell bento-e reveal" style={{ transitionDelay: '140ms' }}>
              <span className="landing-feature-icon">
                <CoinsIcon size={22} />
              </span>
              <h3>Your currency</h3>
              <p>Track in ₱, $, €, and more — exact to the last cent.</p>
            </div>
            <div className="landing-feature bento-cell bento-f reveal" style={{ transitionDelay: '100ms' }}>
              <span className="landing-feature-icon">
                <ShieldIcon size={22} />
              </span>
              <h3>Private by design</h3>
              <p>No ads, no trackers, no selling your data. Your finances stay yours.</p>
            </div>
          </div>
        </section>

        <section className="landing-cta">
          <div className="landing-cta-band reveal">
            <h2>Start tracking in minutes — it’s free.</h2>
            <p>Create an account and add your first transaction today. No setup, no clutter.</p>
            <div className="landing-cta-row landing-cta-center">{primary}</div>
          </div>
        </section>
      </main>

      <footer className="landing-foot">
        <div className="landing-foot-brand">
          <span className="landing-brand">
            <span className="logo-badge">
              <WalletIcon size={16} />
            </span>
            SpendTracker
          </span>
          <span className="landing-copy">© 2026 Savneria — a product of Sveneria.</span>
        </div>
        <div className="landing-foot-links">
          <a href="/privacy" target="_blank" rel="noopener noreferrer">
            Privacy
          </a>
          <span aria-hidden="true">·</span>
          <a href="/terms" target="_blank" rel="noopener noreferrer">
            Terms
          </a>
          <span aria-hidden="true">·</span>
          <Link to="/login">Sign in</Link>
        </div>
      </footer>
    </div>
  );
}

// Static, on-brand mock of the dashboard — pure CSS/SVG, decorative (aria-hidden).
// On mount it counts the numbers up and grows the bars in (skipped when the user
// prefers reduced motion).
function DashboardPreview({ motionOK }: { motionOK: { current: boolean } }) {
  const ref = useRef<HTMLDivElement>(null);
  const bars = [
    { i: 62, e: 40 },
    { i: 48, e: 52 },
    { i: 70, e: 45 },
    { i: 55, e: 38 },
    { i: 80, e: 60 },
    { i: 66, e: 42 },
  ];

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const nums = Array.from(el.querySelectorAll<HTMLElement>('[data-count]'));
    const fmt = (n: number) => '$' + Math.round(n).toLocaleString('en-US');

    if (!motionOK.current) {
      el.classList.add('lp-run');
      nums.forEach((n) => (n.textContent = fmt(Number(n.dataset.count))));
      return;
    }

    requestAnimationFrame(() => el.classList.add('lp-run'));
    let start = 0;
    let raf = 0;
    const dur = 950;
    const tick = (t: number) => {
      if (!start) start = t;
      const p = Math.min(1, (t - start) / dur);
      const e = 1 - Math.pow(1 - p, 3); // easeOutCubic
      nums.forEach((n) => (n.textContent = fmt(Number(n.dataset.count) * e)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [motionOK]);

  return (
    <div className="lp-window" ref={ref}>
      <div className="lp-bar">
        <span className="lp-dot" />
        <span className="lp-dot" />
        <span className="lp-dot" />
        <span className="lp-bar-title">July 2026 overview</span>
      </div>
      <div className="lp-body">
        <div className="lp-stats">
          <div className="lp-stat">
            <span>Income</span>
            <b className="lp-green" data-count="4200">
              $0
            </b>
          </div>
          <div className="lp-stat">
            <span>Expenses</span>
            <b className="lp-red" data-count="2860">
              $0
            </b>
          </div>
          <div className="lp-stat">
            <span>Net</span>
            <b data-count="1340">$0</b>
          </div>
        </div>

        <div className="lp-chart">
          <div className="lp-chart-title">Income vs expenses</div>
          <div className="lp-bars">
            {bars.map((b, idx) => (
              <div className="lp-bar-group" key={idx}>
                <span
                  className="lp-bar-i"
                  style={{ height: `${b.i}%`, animationDelay: `${idx * 55}ms` }}
                />
                <span
                  className="lp-bar-e"
                  style={{ height: `${b.e}%`, animationDelay: `${idx * 55 + 25}ms` }}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="lp-budgets">
          <div className="lp-budget">
            <div className="lp-budget-line">
              <span>
                <i className="lp-cat-dot" style={{ background: '#84cc16' }} />
                Groceries
              </span>
              <span className="lp-budget-num">$242 / $150 /wk</span>
            </div>
            <div className="lp-track">
              <span className="lp-fill lp-over" style={{ width: '100%' }} />
            </div>
          </div>
          <div className="lp-budget">
            <div className="lp-budget-line">
              <span>
                <i className="lp-cat-dot" style={{ background: '#38bdf8' }} />
                Transport
              </span>
              <span className="lp-budget-num">$180 / $500 /mo</span>
            </div>
            <div className="lp-track">
              <span className="lp-fill" style={{ width: '36%' }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
