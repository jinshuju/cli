import { UsageError } from '../options.js';
import { bodyChoices, call } from '../spec.js';
import { given, requiredOption } from './shared.js';
import type { ArgSpec, Command } from './types.js';

const ARTIFACT_ARG: ArgSpec = {
  name: 'artifact',
  required: true,
  description: 'Version id, version token, or the artifact address https://…/artifacts/<token>'
};

/**
 * The version an `<artifact>` names, as the path takes it. An address is the
 * page a version is shown on, and its token is that version's; the share link
 * on jinapp.net names the share, not a version, so it is refused here rather
 * than sent and answered with a 404 that says nothing about why.
 */
function artifactVersion(value: string): string {
  const text = value.trim();
  if (!text.includes('/')) {
    if (!text) throw new UsageError('<artifact> is empty');
    return text;
  }
  const notAnAddress = new UsageError(
    `${JSON.stringify(value)} is not an artifact address: expected https://…/artifacts/<token>, ` +
      'a version id or a version token'
  );
  try {
    const { pathname } = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    const token = /^\/artifacts\/([^/]+)\/?$/.exec(pathname)?.[1];
    if (!token) throw notAnAddress;
    return decodeURIComponent(token);
  } catch {
    throw notAnAddress;
  }
}

export const ARTIFACT: readonly Command[] = [
  {
    path: ['artifact', 'share', 'get'],
    summary: 'Show who can open an artifact’s share link, the link, and which version it shows',
    description:
      'The first get creates the link, open to you only (private); a plan without share links gets 402 ' +
      '(paid_plan_required) instead. can_use_internal says whether the plan includes internal; account_name ' +
      'is the account whose members internal lets in; banned, whether the version the link shows was ' +
      'banned for its content, so the link opens to no one until another version is shared.',
    args: [ARTIFACT_ARG],
    request: (input) =>
      call('getPublishedArtifact', { path: { artifact_id: artifactVersion(input.args.artifact as string) } }),
    examples: [
      'jinshuju artifact share get https://next.jinshuju.net/artifacts/Xy7Qm2PaLk9W',
      'jinshuju artifact share get Xy7Qm2PaLk9W'
    ]
  },
  {
    path: ['artifact', 'share', 'set'],
    summary: 'Change who can open an artifact’s share link, and which version it shows',
    description:
      'internal and public bind the link to the version <artifact> names; to share another version of the ' +
      'same artifact, name that one. private keeps the version the link shows. Only an ' +
      'HTML version whose file is still there can be shared, and not a banned one; those are refused ' +
      'with 422. private: only you; internal: members of your account; public: anyone with the link. ' +
      'Beyond private needs a plan with share links, and internal one with members-only sharing; ' +
      'otherwise 402. Where sharing is not open to the account, beyond private is refused with 403.',
    args: [ARTIFACT_ARG],
    options: [
      {
        name: '--audience',
        type: 'string',
        choices: bodyChoices('updatePublishedArtifact', 'allowed_audience'),
        placeholder: '<audience>',
        description: 'Who can open the link: private, internal or public'
      }
    ],
    request: (input) => {
      const version = artifactVersion(input.args.artifact as string);
      const audience = requiredOption(input, 'audience');
      // Without version_id the API keeps the version the link shows, so taking a share back to
      // private from an older version's receipt does not change what a later public share shows.
      return call('updatePublishedArtifact', {
        path: { artifact_id: version },
        body: given({ allowed_audience: audience, version_id: audience === 'private' ? undefined : version })
      });
    },
    examples: [
      'jinshuju artifact share set https://next.jinshuju.net/artifacts/Xy7Qm2PaLk9W --audience public',
      'jinshuju artifact share set Pq4nR8sT2vWx --audience internal',
      'jinshuju artifact share set Xy7Qm2PaLk9W --audience private'
    ]
  }
];
