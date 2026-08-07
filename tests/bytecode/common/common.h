#pragma once

#include <empathy.h>

typedef struct Test_Values_t
{
	uint8_t u8;
	uint16_t u16;
	uint32_t u32;
	uint64_t u64;
	int8_t i8;
	int16_t i16;
	int32_t i32;
	int64_t i64;
	float f32;
	double f64;
	Empathy_Atom atom;
} Test_Values;

typedef struct Test_Context_t
{
	Empathy_Instance instance;
	Empathy_ProgramLayout layout;
} Test_Context;

#define TEST_CHECK(CONDITION) testCheck((CONDITION), #CONDITION, __FILE__, __LINE__)

void testCheck(int passed, const char *condition, const char *file, int line);
void testCreateContext(Test_Context *context);
void testDestroyContext(Test_Context *context);
void testExecuteBytecode(Test_Context *context, const uint8_t *payload, size_t payload_size, Test_Values *values);
