import os from 'node:os';
import { checkPathAccess, fullDiskAccessNote } from '../doctor.js';
import * as service from '../service/index.js';

export async function serviceCommand(sub: string | undefined): Promise<void> {
  switch (sub) {
    case 'install': {
      // Same check `doctor` runs for $HOME — surfaces a TCC (Full Disk Access) block up front,
      // before the service is even installed, instead of a silent failure once it's running headless.
      const homeCheck = checkPathAccess(os.homedir());
      if (!homeCheck.ok && homeCheck.error === 'eperm' && process.platform === 'darwin') {
        console.error(fullDiskAccessNote());
      }
      await service.install();
      console.log('Serviço instalado.');
      return;
    }
    case 'uninstall':
      await service.uninstall();
      console.log('Serviço removido.');
      return;
    case 'status': {
      const active = await service.status();
      console.log(active ? 'ativo ✓' : 'inativo ✗');
      return;
    }
    default:
      console.error('Uso: termhub-agent service install|uninstall|status');
      process.exitCode = 2;
  }
}
