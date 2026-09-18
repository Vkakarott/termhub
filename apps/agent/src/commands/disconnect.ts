import { deleteConfig } from '../config.js';

export function disconnectCommand(): void {
  deleteConfig();
  console.log('Configuração removida. Revogue o token no app.');
}
