module.exports = grammar({
  name: 'mmlx_mdx',

  extras: $ => [/[ \t\f]/, $.comment, $.block_comment],

  rules: {
    source_file: $ => seq(
      repeat(choice(seq($._line, $._newline), $._newline)),
      optional($._line),
    ),
    _line: $ => choice($.metadata, $.voice_definition, $.track_line),
    _newline: () => /\r?\n/,

    metadata: $ => seq($.metadata_command, $.string),
    metadata_command: () => choice(/#[tT][iI][tT][lL][eE]/, /#[pP][cC][mM][fF][iI][lL][eE]/),
    string: () => /"[^"]*"/,

    voice_definition: $ => seq(
      '@', field('number', $.number), '=', '{',
      repeat(choice($.number, ',', $._newline)), '}',
    ),

    track_line: $ => prec.right(seq(field('channel', $.channel), repeat($._command))),
    channel: () => /[A-HP-W]+/,
    channel_reference: () => /[A-HP-W]/,

    _command: $ => choice($.note, $.numeric_note, $.rest, $.control_command, $.repeat_start, $.repeat_end, $.operator),
    note: $ => seq($.note_name, optional($.accidental), optional($.length)),
    note_name: () => /[a-g]/,
    accidental: () => choice('+', '-'),
    numeric_note: $ => seq(alias('n', $.note_name), $.number, optional(seq(',', $.length))),
    rest: $ => seq(alias('r', $.rest_name), optional($.length)),
    length: $ => seq($.length_term, repeat(seq($.length_operator, $.length_term))),
    length_term: $ => seq(optional('%'), $.number, repeat('.')),
    length_operator: () => choice('^', '~'),

    control_command: $ => choice(
      seq(alias(choice('t', '@t', '@', 'o', 'q', '@q', 'v', '@v', 'p', 'k', 'w', 'F', 'MD'), $.command), $.number),
      seq(alias('D', $.command), $.signed_number),
      seq(alias('l', $.command), optional($.length)),
      seq(alias('y', $.command), $.number, ',', $.number),
      seq(alias('S', $.command), choice($.channel_reference, $.number)),
      seq(alias(choice('MP', 'MA'), $.command), $.number, ',', $.number, ',', $.signed_number),
      seq(alias('MH', $.command), $.number, ',', $.number, ',', $.number, ',', $.number, ',', $.number, ',', $.number, ',', $.number),
      alias(choice('MPON', 'MPOF', 'MAON', 'MAOF', 'MHON', 'MHOF', 'W', 'L'), $.command),
    ),
    repeat_start: () => '[',
    repeat_end: $ => seq(']', optional($.number)),
    operator: () => choice('<', '>', '_', '&', '(', ')', '/', '!'),
    number: () => /[0-9]+/,
    signed_number: () => /-?[0-9]+/,
    comment: () => token(seq(';', /[^\r\n]*/)),
    block_comment: () => token(seq('/*', /[^*]*\*+([^/*][^*]*\*+)*/, '/')),
  },
});