.data
values: .word 12, 18, 24

.text
.globl main
main:
    la    $t0, values
    lw    $t1, 0($t0)
    lw    $t2, 4($t0)
    addu  $t3, $t1, $t2
    sw    $t3, 8($t0)

    addiu $sp, $sp, -4
    sw    $t3, 0($sp)

    li    $v0, 10
    syscall
