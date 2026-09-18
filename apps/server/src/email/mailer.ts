import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';

export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** SMTP real (Mailpit em dev, Mailgun/SES/etc. em prod). */
class SmtpMailer implements Mailer {
  private transporter: Transporter;
  constructor(smtp: NonNullable<typeof config.email.smtp>) {
    this.transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.auth,
    });
  }
  async send(mail: Mail): Promise<void> {
    await this.transporter.sendMail({ from: config.email.from, ...mail });
  }
}

/** Sem SMTP configurado (dev): imprime o e-mail no log em vez de enviar. */
class ConsoleMailer implements Mailer {
  constructor(private log: (msg: string) => void) {}
  async send(mail: Mail): Promise<void> {
    this.log(`\n===== E-MAIL (SMTP não configurado) =====\nPara: ${mail.to}\nAssunto: ${mail.subject}\n\n${mail.text}\n==========================================\n`);
  }
}

export function createMailer(log: (msg: string) => void): Mailer {
  if (config.email.smtp) return new SmtpMailer(config.email.smtp);
  if (config.isProd) log('SMTP_HOST ausente: e-mails serão apenas logados');
  return new ConsoleMailer(log);
}
