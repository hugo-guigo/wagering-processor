// Ponto de extensão da autenticação (seção 2 do desafio). Hoje deixa tudo passar: a autenticação
// ficou fora do escopo por decisão, e o desenho previsto está em ARCHITECTURE.md.
//
// Com Keycloak, este guard faria:
// 1. ler o Bearer token do header Authorization (401 se faltar ou for inválido);
// 2. validar assinatura, emissor, audiência e validade do JWT com as chaves públicas (JWKS) do
//    realm; cada provedor é um client OIDC que obtém o token por client credentials;
// 3. ler a claim providerId do token e guardar na requisição;
// 4. comparar essa claim com o providerId da operação, no corpo ou na URL (403 se for diferente).
// Health e métricas não passam por ele. Mensagens da fila são canal interno confiável, mas o
// providerId delas passa pelas mesmas validações de domínio.
import { Injectable, type CanActivate } from '@nestjs/common';

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
