import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

describe('API: /members/:address/summary', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
    
    // Seed dao_totals
    await query(`
      INSERT INTO dao_totals (id, interest_collected, principal_lent, principal_repaid, value_defaulted)
      VALUES (1, '1000', '5000', '2000', '0')
      ON CONFLICT DO NOTHING
    `)
  })
  afterAll(closeDb)

  it('GET /api/members/:address/summary returns 404 for unknown address', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/members/GBIU43K4ICLBGTVHSQJH7F37Y6R6IAGAGJJTNZGJV2GD4V3PD4DG42R3/summary' })
    expect(res.statusCode).toBe(404)
  })

  it('GET /api/members/:address/summary returns unified member data', async () => {
    await query(`
      INSERT INTO members (address, joined_ledger, contribution, stake, exited)
      VALUES 
      ('GBIU43K4ICLBGTVHSQJH7F37Y6R6IAGAGJJTNZGJV2GD4V3PD4DG42R3', 100, '5000', '1000', false),
      ('GD2XX', 100, '5000', '1000', false)
    `)

    await query(`
      INSERT INTO loans (id, borrower, amount, outstanding, total_repayment, status)
      VALUES 
      (1, 'GBIU43K4ICLBGTVHSQJH7F37Y6R6IAGAGJJTNZGJV2GD4V3PD4DG42R3', '1000', '1000', '1100', 'active'),
      (2, 'GBIU43K4ICLBGTVHSQJH7F37Y6R6IAGAGJJTNZGJV2GD4V3PD4DG42R3', '500', '0', '550', 'repaid')
    `)

    await query(`
      INSERT INTO notifications (address, type, title, message, read)
      VALUES 
      ('GBIU43K4ICLBGTVHSQJH7F37Y6R6IAGAGJJTNZGJV2GD4V3PD4DG42R3', 'info', 'Test', 'Msg', false),
      ('GBIU43K4ICLBGTVHSQJH7F37Y6R6IAGAGJJTNZGJV2GD4V3PD4DG42R3', 'info', 'Test 2', 'Msg 2', true)
    `)

    const res = await app.inject({ method: 'GET', url: '/api/members/GBIU43K4ICLBGTVHSQJH7F37Y6R6IAGAGJJTNZGJV2GD4V3PD4DG42R3/summary' })
    expect(res.statusCode).toBe(200)
    
    const body = res.json()
    expect(body.member.address).toBe('GBIU43K4ICLBGTVHSQJH7F37Y6R6IAGAGJJTNZGJV2GD4V3PD4DG42R3')
    expect(body.loans).toHaveLength(2)
    expect(body.loans[0].interest_charge).toBe('100') // Derived via withLoanDerived
    expect(body.unread_notifications).toBe(1)
    
    // Position assertions
    expect(body.position.contribution_share_bps).toBe('5000') // 5000 / 10000 = 50%
    expect(body.position.stake_share_bps).toBe('5000')
    expect(body.position.repaid_loans_count).toBe(1)
    expect(body.position.defaulted_loans_count).toBe(0)
    expect(body.position.defaulted_loans_value).toBe('0')
  })

  it('GET /api/members/:address/summary handles exited member position correctly', async () => {
    await query(`
      INSERT INTO members (address, joined_ledger, contribution, stake, exited)
      VALUES ('GBIU43K4ICLBGTVHSQJH7F37Y6R6IAGAGJJTNZGJV2GD4V3PD4DG42R3', 100, '5000', '1000', true)
    `)
    const res = await app.inject({ method: 'GET', url: '/api/members/GBIU43K4ICLBGTVHSQJH7F37Y6R6IAGAGJJTNZGJV2GD4V3PD4DG42R3/summary' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.position.stake_share_bps).toBe('0') // Exited member has 0% stake share
  })
})
