// Words and numbers the charity stream shows, shared by the stream scene and the control page.

export const money = (n: number, currency: string) => `${currency}${n.toLocaleString('en-US', { maximumFractionDigits: Number.isInteger(n) ? 0 : 2, minimumFractionDigits: Number.isInteger(n) ? 0 : 2 })}`;

/** "Aisha’s donation"; an anonymous gift is "this donation". */
export const whose = (name: string) => (name ? `${name}’s donation` : 'this donation');
