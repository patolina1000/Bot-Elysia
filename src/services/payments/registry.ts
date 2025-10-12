export interface PixCreationParams {
  value_cents: number;
  webhookPath?: string;
  splitRules?: unknown[];
  botSlug?: string;
}

export interface PaymentGateway {
  createPix(params: PixCreationParams): Promise<any>;
  getTransaction(externalId: string): Promise<any>;
}

const gateways = new Map<string, PaymentGateway>();

export function registerGateway(name: string, instance: PaymentGateway): void {
  if (gateways.has(name)) {
    throw new Error(`Payment gateway "${name}" já registrado`);
  }
  gateways.set(name, instance);
}

export function getGateway(name: string): PaymentGateway {
  const gateway = gateways.get(name);
  if (!gateway) {
    throw new Error(`Payment gateway "${name}" não registrado`);
  }
  return gateway;
}
