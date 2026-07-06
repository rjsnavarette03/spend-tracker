import { Link } from 'react-router-dom';
import { WalletIcon } from '../components/Icons';

// Standalone legal pages, reachable whether signed in or out (routed directly
// in AppRoot). Plain-language and tailored to what SpendTracker actually does.
// Not legal advice — have a professional review before/at commercial launch.
const UPDATED = 'July 7, 2026';
const CONTACT = 'support@savneria.com';

export function LegalPage({ doc }: { doc: 'privacy' | 'terms' }) {
  const title = doc === 'privacy' ? 'Privacy Policy' : 'Terms of Use';
  return (
    <div className="legal-page">
      <header className="legal-top">
        <Link to="/" className="legal-brand">
          <span className="logo-badge">
            <WalletIcon size={16} />
          </span>
          SpendTracker
        </Link>
        <Link to="/" className="link-btn">
          ← Back to SpendTracker
        </Link>
      </header>

      <main className="legal-doc">
        <h1>{title}</h1>
        <p className="legal-meta">Last updated: {UPDATED}</p>
        {doc === 'privacy' ? <PrivacyBody /> : <TermsBody />}
        <div className="legal-crosslink">
          {doc === 'privacy' ? (
            <>
              See also our <Link to="/terms">Terms of Use</Link>.
            </>
          ) : (
            <>
              See also our <Link to="/privacy">Privacy Policy</Link>.
            </>
          )}
        </div>
      </main>

      <footer className="legal-foot">
        <Link to="/privacy">Privacy Policy</Link>
        <span aria-hidden="true">·</span>
        <Link to="/terms">Terms of Use</Link>
        <span aria-hidden="true">·</span>
        <Link to="/">Back to app</Link>
      </footer>
    </div>
  );
}

function PrivacyBody() {
  return (
    <>
      <p>
        SpendTracker is a personal budgeting and expense-tracking web app provided under the{' '}
        <strong>Savneria</strong> brand by Sveneria (&quot;Savneria&quot;, &quot;we&quot;,
        &quot;us&quot;, or &quot;our&quot;). This Privacy Policy explains what information we collect,
        how we use it, and the choices you have. It applies to the SpendTracker service (the
        &quot;Service&quot;) at budgettracker.rjsnavarette.com.
      </p>

      <h2>Information we collect</h2>
      <ul>
        <li>
          <strong>Account information.</strong> Your email address, an optional display name, and
          your password. Passwords are stored only as a one-way hash — we never store or see your
          actual password.
        </li>
        <li>
          <strong>Google sign-in (optional).</strong> If you choose to sign in with Google, we
          receive your Google account&apos;s email and a unique Google identifier, and only after
          Google confirms the email is verified. We never receive your Google password.
        </li>
        <li>
          <strong>Financial data you enter.</strong> The accounts, balances, transactions,
          transfers, budgets, categories, notes, currency preference, and any optional account
          images you add. This is the content you create in the app.
        </li>
        <li>
          <strong>Technical data.</strong> A single session cookie that keeps you signed in, plus
          standard server logs (such as your IP address and request timestamps) used for security
          and to prevent abuse.
        </li>
      </ul>
      <p>
        We do <strong>not</strong> use advertising or third-party analytics/tracking cookies, and we
        do not build advertising profiles about you.
      </p>

      <h2>How we use your information</h2>
      <ul>
        <li>To provide the Service — storing and displaying the financial data you enter.</li>
        <li>To create and secure your account and keep you signed in.</li>
        <li>To protect the Service — rate-limiting sign-in attempts and preventing abuse.</li>
        <li>To send account-related emails, such as password-reset links you request.</li>
      </ul>

      <h2>Cookies</h2>
      <p>
        We use a single essential session cookie so you stay signed in. It is HttpOnly, set with
        SameSite=Lax, and marked Secure over HTTPS. We do not use tracking or advertising cookies.
      </p>

      <h2>How your information is shared</h2>
      <p>
        We do <strong>not</strong> sell, rent, or trade your personal or financial information. We
        share data only as needed to run the Service:
      </p>
      <ul>
        <li>
          <strong>Hosting.</strong> Your data is stored on servers operated by our hosting provider
          (Hostinger).
        </li>
        <li>
          <strong>Google (only if you use Google Sign-In).</strong> We verify your sign-in token
          with Google; your use of Google Sign-In is also subject to Google&apos;s privacy policy.
        </li>
        <li>
          <strong>Email delivery.</strong> Password-reset emails are sent from our mail server
          (noreply@budgettracker.rjsnavarette.com).
        </li>
        <li>
          <strong>Legal reasons.</strong> We may disclose information if required by law or to
          protect the rights, safety, or security of our users or the Service.
        </li>
      </ul>

      <h2>Data security</h2>
      <p>
        We take reasonable measures to protect your data: all traffic is encrypted with HTTPS,
        passwords are hashed, requests are protected against cross-site request forgery (CSRF) and
        abuse, and each account&apos;s data is isolated so one user cannot access another&apos;s. No
        online service can be completely secure, so we cannot guarantee absolute security.
      </p>

      <h2>Data retention and your choices</h2>
      <p>
        We keep your data for as long as your account is active. You can add, edit, or delete your
        transactions, budgets, accounts, and categories at any time inside the app. To permanently
        delete your entire account and all associated data, email us at{' '}
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a> — deleting your account removes all of your
        associated financial data.
      </p>

      <h2>Your privacy rights (Philippines)</h2>
      <p>
        Under the Philippine Data Privacy Act of 2012 (Republic Act No. 10173), you have the right
        to be informed, to access, to correct, to object to processing, and to request erasure or
        blocking of your personal data, as well as the right to lodge a complaint with the National
        Privacy Commission (NPC). To exercise any of these rights, contact us at{' '}
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>

      <h2>Children</h2>
      <p>
        SpendTracker is not directed to children under 13, and we do not knowingly collect personal
        information from them. If you believe a child has provided us information, contact us and we
        will delete it.
      </p>

      <h2>International users</h2>
      <p>
        The Service is operated from, and its data may be stored on servers located in,
        jurisdictions outside your own. By using the Service you consent to this.
      </p>

      <h2>Changes to this policy</h2>
      <p>
        We may update this Privacy Policy from time to time. We will change the &quot;Last
        updated&quot; date above and, for significant changes, provide a more prominent notice.
      </p>

      <h2>Contact us</h2>
      <p>
        Questions about this policy or your data? Email{' '}
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>
    </>
  );
}

function TermsBody() {
  return (
    <>
      <p>
        These Terms of Use (&quot;Terms&quot;) govern your use of SpendTracker (the
        &quot;Service&quot;), a personal budgeting and expense-tracking web app provided under the{' '}
        <strong>Savneria</strong> brand by Sveneria (&quot;Savneria&quot;, &quot;we&quot;,
        &quot;us&quot;, or &quot;our&quot;). By creating an account or using the Service, you agree
        to these Terms and to our <Link to="/privacy">Privacy Policy</Link>. If you do not agree,
        please do not use the Service.
      </p>

      <h2>Beta service and future pricing</h2>
      <p>
        SpendTracker is currently in <strong>beta</strong> and free to use. Because it is beta
        software, it may contain bugs, change without notice, or be temporarily unavailable. We plan
        to introduce paid plans in the future. If we do, we will give advance notice, and any paid
        features will be clearly described before you are charged — you will never be billed without
        opting in. Continuing to use the Service after paid plans launch may require choosing a plan
        or accepting updated Terms.
      </p>

      <h2>Your account</h2>
      <ul>
        <li>Provide accurate information and keep your password secure.</li>
        <li>You are responsible for all activity that happens under your account.</li>
        <li>
          Notify us promptly at <a href={`mailto:${CONTACT}`}>{CONTACT}</a> if you suspect
          unauthorized use of your account.
        </li>
        <li>
          You must be at least 18 years old, or the age of majority where you live, or have the
          consent of a parent or legal guardian, to use the Service.
        </li>
      </ul>

      <h2>Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>Use the Service for any unlawful purpose or in violation of these Terms;</li>
        <li>
          Attempt to access another user&apos;s account or data, or probe, scan, or breach the
          Service&apos;s security;
        </li>
        <li>
          Interfere with or disrupt the Service, or place an unreasonable load on it through
          automated means such as bots or scraping;
        </li>
        <li>
          Upload malicious code, or images or content that are unlawful or infringe the rights of
          others.
        </li>
      </ul>

      <h2>Your data and content</h2>
      <p>
        You own the financial data and images you enter. You grant us a limited licence to store and
        process that content solely to operate and provide the Service to you. You are responsible
        for the accuracy of the information you enter.
      </p>
      <p>
        <strong>Not financial advice.</strong> SpendTracker is a tool to help you record and
        organize your money. It does not provide financial, investment, tax, accounting, or legal
        advice, and its totals and calculations are for your convenience only. Verify anything
        important yourself before relying on it.
      </p>

      <h2>Availability and changes</h2>
      <p>
        We may add, change, suspend, or discontinue any part of the Service at any time, particularly
        during beta. We may also update these Terms; if we do, we will update the &quot;Last
        updated&quot; date, and your continued use of the Service means you accept the revised Terms.
      </p>

      <h2>Disclaimer of warranties</h2>
      <p>
        The Service is provided &quot;as is&quot; and &quot;as available&quot;, without warranties of
        any kind, whether express or implied, including fitness for a particular purpose, accuracy,
        or that the Service will be uninterrupted or error-free. You use the Service at your own
        risk. We recommend keeping your own backups of important information.
      </p>

      <h2>Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, Savneria and Sveneria will not be liable for any
        indirect, incidental, special, or consequential damages, or for any loss of data, profits,
        or goodwill, arising from or related to your use of (or inability to use) the Service.
      </p>

      <h2>Termination</h2>
      <p>
        We may suspend or terminate accounts that violate these Terms. You may stop using the Service
        at any time and request deletion of your account as described in our{' '}
        <Link to="/privacy">Privacy Policy</Link>.
      </p>

      <h2>Governing law</h2>
      <p>
        These Terms are governed by the laws of the Republic of the Philippines, without regard to
        its conflict-of-laws rules. Any disputes will be subject to the exclusive jurisdiction of the
        courts located in the Philippines.
      </p>

      <h2>Contact us</h2>
      <p>
        Questions about these Terms? Email <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>
    </>
  );
}
