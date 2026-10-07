(metadata_command) @keyword.directive
(string) @string
(channel) @label
(channel_reference) @label
(command) @keyword
(note_name) @function
(rest_name) @constant.builtin
[(number) (signed_number)] @constant.numeric.integer
[(accidental) (length_operator) (operator)] @operator
["@" "=" "%" "." "!"] @operator
[(repeat_start) "]" "{" "}"] @punctuation.bracket
"," @punctuation.delimiter
[(comment) (block_comment)] @comment