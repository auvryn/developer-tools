import type { Command } from 'commander';

import { details, table } from '../format.js';
import type { Define } from '../program.js';

/** `auth status`, `projects …`, `providers list`. */
export function registerAccountCommands(program: Command, define: Define): void {
  const auth = program.command('auth').description('The API key in use');
  auth
    .command('status')
    .description('Show the API key: organization, project restriction and scopes (never the key)')
    .action(
      define(async (context) => {
        const client = context.client();
        const me = await client.me();
        const principal = me.principal;
        context.print(
          {
            apiUrl: client.inspect().baseUrl,
            principal,
            session: me.session,
          },
          () =>
            principal.kind === 'api-key'
              ? details([
                  ['API URL', client.inspect().baseUrl],
                  ['API key', principal.apiKeyId],
                  ['Organization', principal.organizationId],
                  ['Project', principal.projectId ?? 'all projects'],
                  ['Scopes', principal.scopes.join(', ')],
                  ['Expires', me.session.expiresAt ?? 'never'],
                ])
              : details([['Principal', principal.kind]]),
        );
      }),
    );

  const projects = program.command('projects').description('Projects the API key can reach');
  projects
    .command('list')
    .description('List projects')
    .action(
      define(async (context) => {
        const page = await context.client().projects.list();
        context.print(page, () =>
          table(
            page.data,
            [
              ['ID', 'id'],
              ['Name', 'name'],
              ['Slug', 'slug'],
              ['Created', 'createdAt'],
            ],
            'No projects.',
          ),
        );
      }),
    );
  projects
    .command('get')
    .description('Show a project')
    .argument('<projectId>', 'prj_…')
    .action(
      define<[string]>(async (context, _options, projectId) => {
        const project = await context.client().projects.get({ projectId });
        context.print(project, () =>
          details([
            ['ID', project.id],
            ['Name', project.name],
            ['Slug', project.slug],
            ['Organization', project.organizationId],
            ['Created', project.createdAt],
          ]),
        );
      }),
    );

  program
    .command('providers')
    .description('Execution providers available in this environment')
    .command('list')
    .description('List providers')
    .action(
      define(async (context) => {
        const page = await context.client().providers.list();
        context.print(page, () =>
          table(
            page.data,
            [
              ['ID', 'id'],
              ['Name', 'name'],
            ],
            'No providers.',
          ),
        );
      }),
    );
}
