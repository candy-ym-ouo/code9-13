import type { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { errors } from './errors.js';
import { logger } from '../logger.js';
import { fail } from './respond.js';
import type { AuthUser } from '@flil/shared';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthUser;
    requestId?: string;
  }
}

export interface JwtPayload extends AuthUser {
  iat?: number;
  exp?: number;
}

export function signToken(user: AuthUser): string {
  return jwt.sign({ ...user }, config.jwtSecret, { expiresIn: '7d' });
}

export function requestId(req: Request, res: Response, next: NextFunction): void {
  req.requestId = req.header('x-request-id') ?? crypto.randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
}

export function requestLog(req: Request, res: Response, next: NextFunction): void {
  const started = Date.now();
  res.on('finish', () => {
    logger.info('http', {
      requestId: req.requestId,
      method: req.method,
      // 只记路径模式，避免 query 里夹带坐标
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - started,
    });
  });
  next();
}

export function authenticate(required = true) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization');
    let token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    // EventSource / <img> 等无法携带 Authorization 头的客户端，允许用 ?token= 传递
    if (!token && typeof req.query.token === 'string') token = req.query.token;
    if (!token) {
      if (required) {
        fail(res, errors.authRequired());
        return;
      }
      next();
      return;
    }
    try {
      req.auth = jwt.verify(token, config.jwtSecret) as JwtPayload;
      next();
    } catch {
      if (required) {
        fail(res, errors.authRequired());
        return;
      }
      next();
    }
  };
}

/** 仅供无法使用标准鉴权中间件的流式端点使用（SSE 需在鉴权通过前保持响应不写出） */
export function verifyToken(token: string | undefined): JwtPayload | null {
  if (!token) return null;
  try {
    return jwt.verify(token, config.jwtSecret) as JwtPayload;
  } catch {
    return null;
  }
}

export function requireOwner(req: Request): void {
  if (!req.auth) throw errors.authRequired();
  if (req.auth.role !== 'owner') throw errors.forbiddenRole('该操作仅所有者（owner）可执行');
}

export function currentUser(req: Request): AuthUser {
  if (!req.auth) throw errors.authRequired();
  return req.auth;
}

/** 简单内存限流（个人自用场景足够） */
export function rateLimit(name: string, max: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${name}:${req.ip ?? 'unknown'}`;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt < now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    entry.count += 1;
    if (entry.count > max) {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: '请求过于频繁', details: {} } });
      return;
    }
    next();
  };
}
