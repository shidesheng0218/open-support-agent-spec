/**
 * Security Plugin
 * 
 * Runtime security hardening for known vulnerabilities and attack vectors.
 */

import type { FastifyPluginAsync } from 'fastify';

const securityPlugin: FastifyPluginAsync = async (fastify) => {
  const isProduction = process.env.NODE_ENV === 'production';
  
  // Hook 1: Block Vitest UI in production (CVE mitigation)
  if (isProduction) {
    fastify.addHook('onRequest', async (request, reply) => {
      if (request.url.includes('/__vitest') || request.url.includes('/@vite')) {
        fastify.log.warn({ url: request.url }, 'Blocked dev-only endpoint in production');
        return reply.code(404).send({ error: 'Not Found' });
      }
    });
  }
  
  // Hook 2: Validate X-Forwarded-For format (proxy-addr CVE mitigation)
  fastify.addHook('preHandler', async (request, reply) => {
    const xff = request.headers['x-forwarded-for'];
    
    if (xff && typeof xff === 'string') {
      // Reject IPv4-mapped IPv6 format (::ffff:x.x.x.x) which can bypass trust checks
      if (xff.includes('::ffff:')) {
        fastify.log.warn(
          { xff, ip: request.ip, url: request.url },
          'Rejected IPv4-mapped IPv6 address in X-Forwarded-For'
        );
        return reply.code(400).send({ 
          error: 'Bad Request',
          message: 'Invalid IP format in X-Forwarded-For header' 
        });
      }
      
      // Basic validation: ensure it looks like valid IPs (v4 or v6)
      const ips = xff.split(',').map(ip => ip.trim());
      for (const ip of ips) {
        // IPv4: x.x.x.x
        const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
        // IPv6: simplified check (full validation is complex)
        const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
        
        if (!ipv4Regex.test(ip) && !ipv6Regex.test(ip)) {
          fastify.log.warn(
            { xff, invalidIp: ip, url: request.url },
            'Rejected malformed IP in X-Forwarded-For'
          );
          return reply.code(400).send({ 
            error: 'Bad Request',
            message: 'Malformed IP address in X-Forwarded-For header' 
          });
        }
      }
    }
  });
  
  // Hook 3: Add security headers
  fastify.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-XSS-Protection', '1; mode=block');
    
    // Don't send server version in production
    if (isProduction) {
      reply.removeHeader('X-Powered-By');
    }
  });
  
  fastify.log.info('Security plugin loaded');
};

export default securityPlugin;
