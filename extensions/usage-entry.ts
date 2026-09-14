import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import lanArtifacts from './lan-artifacts';
import { createUsageFunnel } from './usage-funnel';

const version = '0.1.1';

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
