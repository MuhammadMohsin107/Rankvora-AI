import { AtSign, Briefcase, CalendarDays, ShieldCheck, Store, UserRound } from 'lucide-react';
import type { SettingsState } from '../../data/settings.config';
import { Field, SettingsCard, TextInput, settingsCard } from './SettingsPrimitives';

/** Two letters from the name being typed, so the avatar tracks the field live. */
function initialsOf(fullName: string): string {
  return (
    fullName
      .split(' ')
      .map((part) => part[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || 'S'
  );
}

/** `createdAt` is an ISO string from the API; a malformed one must not render "Invalid Date". */
function monthAndYear(isoDate: string): string | null {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** Small label/value pair used across the identity card's meta strip. */
function MetaPill({ icon: Icon, label, value }: { icon: typeof UserRound; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-surface-200 bg-surface-0 px-2 py-1">
      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-surface-100 text-surface-600">
        <Icon size={11} aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block text-[9.5px] font-bold uppercase tracking-[0.11em] text-surface-400">{label}</span>
        <span className="block truncate text-[12px] font-semibold text-surface-800">{value}</span>
      </span>
    </div>
  );
}

interface ProfileSectionProps {
  profile: SettingsState['profile'];
  workspace: SettingsState['workspace'];
  errors: Record<string, string>;
  onChange: (patch: Partial<SettingsState['profile']>) => void;
}

export default function ProfileSection({ profile, workspace, errors, onChange }: ProfileSectionProps) {
  const initials = initialsOf(profile.fullName);
  const memberSince = monthAndYear(profile.createdAt);
  const displayName = profile.fullName.trim() || 'Your name';

  return (
    <>
      {/* ── Identity card ───────────────────────────────────────────────
          NO DECORATIVE BAND. There used to be a 64px gradient header with the avatar pulled up
          -36px to straddle it. The name was aligned to the BOTTOM of a 72px avatar, so it landed
          exactly on the band's lower edge — dark type printed half on purple and half on white,
          which is why the name was unreadable.
          Nudging the offsets would have left the same trap one long name away, so the band is
          gone: this is now a plain flex row where the avatar and the name share one ground and
          cannot overlap anything at any width. The band carried no information, so nothing was
          lost with it — and the card is ~90px shorter. */}
      <section className={`${settingsCard} px-3 py-2.5`}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 text-[14px] font-bold tracking-tight text-white"
              aria-hidden="true"
            >
              {initials}
            </span>
            <div className="min-w-0">
              <h3 className="truncate text-[15px] font-bold leading-tight tracking-tight text-surface-950">
                {displayName}
              </h3>
              <p className="truncate text-[11.5px] text-surface-500">
                {profile.jobTitle.trim() || 'No job title set'}
              </p>
            </div>
          </div>

          <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded border border-brand-100 bg-brand-50 px-1.5 py-0.5 text-[10.5px] font-bold text-brand-700">
              <ShieldCheck size={11} aria-hidden="true" />
              {profile.role}
            </span>
          </div>
        </div>

        <div className="mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          <MetaPill icon={AtSign} label="Email" value={profile.email || '—'} />
          {memberSince && <MetaPill icon={CalendarDays} label="Member since" value={memberSince} />}
          <MetaPill icon={Store} label="Workspace" value={workspace.workspaceName || '—'} />
        </div>
      </section>

      {/* ── Editable details ────────────────────────────────────────── */}
      <SettingsCard
        title="Personal information"
        description="Shown across your Rankvora AI workspace and used as the address for account email."
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Full name" htmlFor="fullName" error={errors.fullName} hint="Used across your Rankvora AI workspace.">
            <TextInput
              id="fullName"
              value={profile.fullName}
              onChange={(value) => onChange({ fullName: value })}
              placeholder="Your full name"
              invalid={Boolean(errors.fullName)}
              describedBy={errors.fullName ? 'fullName-error' : 'fullName-hint'}
            />
          </Field>

          <Field
            label="Email address"
            htmlFor="email"
            error={errors.email}
            hint="Used to sign in and as the address for account email."
          >
            <TextInput
              id="email"
              type="email"
              value={profile.email}
              onChange={(value) => onChange({ email: value })}
              placeholder="you@example.com"
              invalid={Boolean(errors.email)}
              describedBy={errors.email ? 'email-error' : 'email-hint'}
            />
          </Field>

          <Field label="Job title" htmlFor="jobTitle" hint="Optional. Helps tailor recommendations.">
            <TextInput
              id="jobTitle"
              value={profile.jobTitle}
              onChange={(value) => onChange({ jobTitle: value })}
              placeholder="e.g. Head of Ecommerce"
              describedBy="jobTitle-hint"
            />
          </Field>

          {/* Role is assigned server-side, so it is presented as a value rather than as a
              disabled input that looks like it could be typed into. */}
          <div>
            <p className="block text-[12.5px] font-semibold text-surface-800">Role</p>
            <div className="mt-1 flex items-center gap-2 rounded-md border border-surface-200 bg-surface-50 px-2.5 py-1.5">
              <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-surface-0 text-brand-600 ring-1 ring-surface-200">
                <Briefcase size={12} aria-hidden="true" />
              </span>
              <span className="text-[12.5px] font-semibold text-surface-700">{profile.role}</span>
            </div>
            <p className="mt-1 text-[11.5px] leading-[1.45] text-surface-500">Roles are assigned by the workspace owner.</p>
          </div>
        </div>
      </SettingsCard>

      {/* The Avatar card was removed. It showed the same monogram at three sizes plus a notice
          explaining that image upload is not built — a whole card of viewport spent telling the
          customer about something they cannot do. The monogram is already visible in the identity
          row above and in the header, and it still updates live from the name field. */}
    </>
  );
}
