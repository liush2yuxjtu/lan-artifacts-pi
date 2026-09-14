import { readFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import lanArtifacts from './lan-artifacts.ts';
import { createUsageFunnel } from './usage-funnel.ts';

const version = String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);

export default function usageInstrumentedLanArtifacts(pi: ExtensionAPI): void {
  const funnel = createUsageFunnel('lan-artifacts-pi', version);
  pi.on('session_start', () => { void funnel.launch(); });

  const instrumented = new Proxy(pi, {
    get(target, property, receiver) {
      if (property !== 'registerTool') return Reflect.get(target, property, receiver);
      return (tool: any) => {
        if (tool?.name !== 'artifact_publish' || typeof tool.execute !== 'function') return target.registerTool(tool);
        const execute = tool.execute.bind(tool);
        return target.registerTool({
          ...tool,
          async execute(...args: any[]) {
            const result = await execute(...args);
            void funnel.success();
            return result;
          },
        });
      };
    },
  }) as ExtensionAPI;

  lanArtifacts(instrumented);
}
