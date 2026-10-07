use serde::Deserialize;

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Voice {
    pub algorithm: u8,
    pub feedback: u8,
    pub operator_mask: u8,
    pub operators: [Operator; 4],
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Operator {
    pub ar: u8,
    pub d1r: u8,
    pub d2r: u8,
    pub rr: u8,
    pub d1l: u8,
    pub tl: u8,
    pub ks: u8,
    pub mul: u8,
    pub dt1: u8,
    pub dt2: u8,
    pub ame: u8,
}

impl Voice {
    pub fn validate(&self) -> bool {
        self.algorithm <= 7
            && self.feedback <= 7
            && self.operator_mask <= 15
            && self.operators.iter().all(|operator| {
                operator.ar <= 31
                    && operator.d1r <= 31
                    && operator.d2r <= 31
                    && operator.rr <= 15
                    && operator.d1l <= 15
                    && operator.tl <= 127
                    && operator.ks <= 3
                    && operator.mul <= 15
                    && operator.dt1 <= 7
                    && operator.dt2 <= 3
                    && operator.ame <= 1
            })
    }

    pub fn registers(&self, channel: u8, attenuation: u8) -> Vec<(u8, u8)> {
        let carriers = [8_u8, 8, 8, 8, 12, 14, 14, 15][self.algorithm as usize];
        let mut registers = vec![
            (0x20 + channel, 0xc0 | (self.feedback << 3) | self.algorithm),
            (0x38 + channel, 0),
        ];
        for (index, operator) in self.operators.iter().enumerate() {
            let physical = [0_u8, 2, 1, 3][index];
            let slot = physical * 8 + channel;
            let tl = if carriers & (1 << physical) != 0 {
                operator.tl.saturating_add(attenuation).min(127)
            } else {
                operator.tl
            };
            registers.extend([
                (0x40 + slot, (operator.dt1 << 4) | operator.mul),
                (0x60 + slot, tl),
                (0x80 + slot, (operator.ks << 6) | operator.ar),
                (0xa0 + slot, (operator.ame << 7) | operator.d1r),
                (0xc0 + slot, (operator.dt2 << 6) | operator.d2r),
                (0xe0 + slot, (operator.d1l << 4) | operator.rr),
            ]);
        }
        registers
    }
}
