// Every mock card shows this text. The main process rejects a signed pass without it.
export const cardNotice = 'Experimental — Not a payment card'

export interface MockCardInput {
  cardholder: string
  label: string
}

export interface CardsAPI {
  createMockCard: (input: MockCardInput) => Promise<string>
  shareMockCard: (id: string) => Promise<void>
}
